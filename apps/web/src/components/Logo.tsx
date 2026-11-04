/**
 * The MAYBE mark: one stem that forks. The committed path is solid and ends in
 * a point; the other path is dotted — a future that might not happen.
 * Together they make the "y" of maybe without drawing a letter.
 */
export function Mark({ size = 22, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className}>
      <path d="M12 21.5V13.2" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
      <path d="M12 13.2 18.6 4.6" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
      <path d="M12 13.2 5.4 4.6" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeDasharray="0.1 3.6" />
      <circle cx="18.9" cy="4.2" r="2.1" fill="var(--c-accent)" />
    </svg>
  );
}

export function Wordmark() {
  return (
    <span className="wordmark" style={{ fontWeight: 640, fontSize: 18, letterSpacing: "-0.035em", fontVariationSettings: '"wdth" 92' }}>
      maybe
    </span>
  );
}

export function Logo() {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8, color: "var(--c-text)" }}>
      <Mark />
      <Wordmark />
    </span>
  );
}
