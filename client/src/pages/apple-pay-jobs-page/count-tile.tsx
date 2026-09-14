export function CountTile({ label, value, tone }: { label: string; value: number; tone?: 'success' | 'danger' }) {
  const toneClass = tone === 'success'
    ? 'text-positive-600'
    : tone === 'danger'
      ? 'text-destructive'
      : 'text-foreground';
  return (
    <div className="rounded-md border bg-card p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={`text-2xl font-semibold ${toneClass}`}>{value}</div>
    </div>
  );
}
