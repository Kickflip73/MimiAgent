import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

/** Resolve the last explicit owner workspace, including detached scheduled-run sessions. */
export function savedSessionWorkspace(database: DatabaseSync, sessionId: string): string | undefined {
  const row = database.prepare(`
    SELECT json_extract(t.objective_json, '$.workspaceRoot') AS workspace
    FROM tasks t JOIN events e ON e.id = t.authority_event_id
    WHERE e.trust = 'owner' AND json_type(t.objective_json, '$.workspaceRoot') = 'text'
      AND t.id IN (
        SELECT id FROM tasks WHERE session_key = ?
        UNION SELECT task_id FROM runs WHERE session_key = ?
      )
    ORDER BY t.created_at DESC, t.id DESC LIMIT 1
  `).get(sessionId, sessionId);
  return typeof row?.workspace === 'string' && path.isAbsolute(row.workspace)
    ? path.resolve(row.workspace) : undefined;
}
