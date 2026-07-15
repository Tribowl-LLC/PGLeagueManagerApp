# Legacy migration evidence — do not replay

This directory preserves the pre-normalization migration artifacts as review
evidence. Its journal selected only eight files and did not reconstruct the
current application schema; the remaining generated, hand-authored,
destructive, ignored, and historical SQL was never one authoritative replay
chain.

No package command or Drizzle configuration points here. Do not batch-apply,
generate into, adopt from, or edit this history to represent current state.
The authoritative forward-only history is `../migrations/`.
