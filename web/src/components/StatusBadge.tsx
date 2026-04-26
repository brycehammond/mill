import type { RunStatus, StageStatus, Severity } from "../types.js";

// Status indicators. Color + icon (•/✓/✕/▾) so red/green colorblind
// users still parse the state. Tailwind class strings are spelled out
// rather than computed so the JIT picks them up.

const RUN_STYLES: Record<RunStatus, { cls: string; glyph: string; label: string }> = {
  queued: { cls: "bg-ink-600 text-ink-100", glyph: "·", label: "queued" },
  awaiting_clarification: {
    cls: "bg-amber-900/60 text-amber-200",
    glyph: "?",
    label: "awaiting",
  },
  running: { cls: "bg-blue-900/60 text-blue-200", glyph: "▸", label: "running" },
  completed: { cls: "bg-emerald-900/60 text-emerald-200", glyph: "✓", label: "completed" },
  failed: { cls: "bg-rose-900/60 text-rose-200", glyph: "✕", label: "failed" },
  killed: { cls: "bg-rose-900/60 text-rose-300", glyph: "■", label: "killed" },
};

export function RunStatusBadge({ status }: { status: RunStatus }) {
  const s = RUN_STYLES[status];
  return (
    <span
      className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-mono ${s.cls}`}
      aria-label={`status ${s.label}`}
    >
      <span aria-hidden="true">{s.glyph}</span>
      {s.label}
    </span>
  );
}

const STAGE_STYLES: Record<StageStatus, { cls: string; glyph: string }> = {
  pending: { cls: "text-ink-300", glyph: "·" },
  running: { cls: "text-blue-300", glyph: "▸" },
  completed: { cls: "text-emerald-300", glyph: "✓" },
  failed: { cls: "text-rose-300", glyph: "✕" },
  skipped: { cls: "text-ink-300", glyph: "—" },
};

export function StageStatusGlyph({ status }: { status: StageStatus }) {
  const s = STAGE_STYLES[status];
  return (
    <span
      className={`font-mono ${s.cls}`}
      aria-label={`stage ${status}`}
      title={status}
    >
      {s.glyph}
    </span>
  );
}

const SEVERITY_STYLES: Record<Severity, string> = {
  LOW: "bg-ink-700 text-ink-200",
  MEDIUM: "bg-amber-900/60 text-amber-200",
  HIGH: "bg-orange-900/70 text-orange-200",
  CRITICAL: "bg-rose-900/80 text-rose-100",
};

export function SeverityBadge({ severity }: { severity: Severity }) {
  return (
    <span
      className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-mono uppercase ${SEVERITY_STYLES[severity]}`}
    >
      {severity}
    </span>
  );
}
