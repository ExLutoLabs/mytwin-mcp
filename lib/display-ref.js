// Display-ref helper — single source of truth for the user-facing record reference.
//
// The model frequently leaks bare UUIDs into prose ("connects to f09ff3c6…") even
// when the system prompt asks it not to. The structural fix is to never make it
// compose that string in the first place: every tool response carries a ready-made
// `display_ref` string of the form "<title> (<shortid>)" that the model is told to
// use verbatim. Composing nothing, dropping a string is the easy path.

// Short-id = first 8 chars of a UUID (or the whole id if shorter). Cheap to read,
// unique enough for the user's mental model, and matches the examples in the
// system prompt: "The cattail as complete business metaphor (3d4c2db4)".
export function shortId(id) {
  if (!id) return '';
  return String(id).slice(0, 8);
}

// Format a record into a display reference string.
// - Untitled items become "untitled (<shortid>)" so the model never has to invent a label.
// - Missing id (shouldn't happen — every persisted record has one) falls back to title alone.
export function formatDisplayRef({ id, title } = {}) {
  const sid = shortId(id);
  const label = (title && String(title).trim()) || 'untitled';
  return sid ? `${label} (${sid})` : label;
}
