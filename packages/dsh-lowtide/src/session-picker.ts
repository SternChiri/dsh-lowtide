/**
 * Workspace session picker: enumerate dsh conversations from the official
 * storage files, grouped by workspace, so a new off-peak task can resume an
 * existing conversation. Read-only; session payloads are loaded by dsh itself.
 *
 * Data sources:
 *   $DSH_HOME/storages/workspace.json
 *     tables.workspaces.<id> = { path, title, sessionIds, updatedAt }
 *   Legacy: $DSH_HOME/storages/session_projcache.json
 *     tables.sessions.<sessionId> = { identity, rows }
 *   Current: $DSH_HOME/storages/session_projcache/sessions/<sessionId>.json
 *     { version, record: { identity, rows } }
 * Last activity = lastPromptAt (fallback: createdAt).
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface WorkspaceSession {
  id: string
  /** Conversation title or first-prompt label from the projection cache. */
  title: string | null
  lastModified: number
}

export interface WorkspaceSessions {
  cwd: string
  label: string | null
  sessions: WorkspaceSession[]
}

interface ProjectionRecord {
  identity?: { createdAt?: unknown }
  rows?: {
    title?: { val?: unknown }
    titleInput?: { val?: { first?: { text?: unknown } } }
    sessionListMetadata?: { val?: { lastPromptAt?: unknown; blank?: unknown } }
  }
}

export function storagesDir(): string {
  return join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'storages')
}

function readJsonSafe(file: string): Record<string, unknown> | null {
  if (!existsSync(file)) return null
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown
    return parsed !== null && typeof parsed === 'object' ? parsed as Record<string, unknown> : null
  } catch {
    return null
  }
}

function projectionRecord(value: unknown): ProjectionRecord | null {
  if (value === null || typeof value !== 'object') return null
  const record = value as ProjectionRecord
  if (record.identity === null || typeof record.identity !== 'object') return null
  if (record.rows === null || typeof record.rows !== 'object') return null
  return record
}

function readPerRecordProjection(dir: string, id: string): ProjectionRecord | null {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) return null
  const document = readJsonSafe(join(dir, 'session_projcache', 'sessions', `${id}.json`))
  return projectionRecord(document?.record)
}

function displayTitle(record: ProjectionRecord | undefined): string | null {
  const title = record?.rows?.title?.val
  if (typeof title === 'string' && title.trim() !== '') return title
  const firstPrompt = record?.rows?.titleInput?.val?.first?.text
  if (typeof firstPrompt !== 'string' || firstPrompt.trim() === '') return null
  const summary = firstPrompt.replace(/\s+/g, ' ').trim()
  return summary.length > 80 ? `${summary.slice(0, 80)}…` : summary
}

/** List conversations per workspace, most recently active first. */
export function listWorkspaceSessions(limitPerWorkspace = 30): WorkspaceSessions[] {
  const dir = storagesDir()
  const ws = readJsonSafe(join(dir, 'workspace.json'))
  const proj = readJsonSafe(join(dir, 'session_projcache.json'))
  if (ws === null) return []

  const wsTables = ws.tables as Record<string, unknown> | undefined
  const workspaces = wsTables?.workspaces as Record<string, { path?: unknown; title?: unknown; sessionIds?: unknown }> | undefined
  const archived = new Set(
    Array.isArray((ws.global as Record<string, unknown> | undefined)?.archivedSessionIds)
      ? ((ws.global as Record<string, unknown>).archivedSessionIds as unknown[]).filter((x): x is string => typeof x === 'string')
      : [],
  )
  const projSessions = (proj?.tables as Record<string, unknown> | undefined)?.sessions as
    | Record<string, ProjectionRecord>
    | undefined

  const result: WorkspaceSessions[] = []
  for (const entry of Object.values(workspaces ?? {})) {
    if (typeof entry.path !== 'string') continue
    const ids = Array.isArray(entry.sessionIds)
      ? entry.sessionIds.filter((id): id is string =>
          typeof id === 'string' && !id.startsWith('lt-') && !id.startsWith('ns-'))
      : []
    const sessions: WorkspaceSession[] = []
    for (const id of ids) {
      const cached = readPerRecordProjection(dir, id) ?? projSessions?.[id]
      if (cached?.rows?.sessionListMetadata?.val?.blank === true) continue
      if (archived.has(id)) continue
      const createdAt = cached?.identity?.createdAt
      const lastPromptAt = cached?.rows?.sessionListMetadata?.val?.lastPromptAt
      sessions.push({
        id,
        title: displayTitle(cached),
        lastModified: typeof lastPromptAt === 'number' ? lastPromptAt : typeof createdAt === 'number' ? createdAt : 0,
      })
    }
    if (sessions.length === 0) continue
    sessions.sort((a, b) => b.lastModified - a.lastModified)
    result.push({
      cwd: entry.path,
      label: typeof entry.title === 'string' ? entry.title : null,
      sessions: sessions.slice(0, limitPerWorkspace),
    })
  }
  result.sort((a, b) => (b.sessions[0]?.lastModified ?? 0) - (a.sessions[0]?.lastModified ?? 0))
  return result
}
