/** A script as people read it: its `name:` (bold) with the file path small and dimmed; the path when it has no name. */
export function ScriptLabel({ path, name }: { path: string; name?: string | undefined }) {
  return name ? (
    <span className="script-label" title={path}>
      <b>{name}</b> <span className="muted small">{path}</span>
    </span>
  ) : (
    <span className="script-label">{path}</span>
  );
}
