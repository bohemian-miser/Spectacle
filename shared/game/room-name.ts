/**
 * A room name from a `?room=` link: lowercase letters, digits and dashes, at
 * most 24 of them. The client cleans it for show; the server cleans it again.
 */
export function cleanRoomName(raw: unknown): string | null {
  const s = String(raw ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);
  return s || null;
}
