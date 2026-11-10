/**
 * Session picker: enumerate dsh conversations from workspace.json and both
 * generations of the session projection cache, grouped by workspace.
 */
import { afterEach, describe, expect, test } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listWorkspaceSessions } from '../src/session-picker.ts'

const roots: string[] = []

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lt-sess-'))
  roots.push(dir)
  mkdirSync(join(dir, 'storages'), { recursive: true })
  return dir
}

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
  delete process.env.DSH_HOME
})

function seed(home: string, workspaces: unknown, sessions: unknown, archived: string[] = []): void {
  writeFileSync(join(home, 'storages', 'workspace.json'), JSON.stringify({
    unit: { name: 'workspace', version: 2 },
    global: { initialized: true, workspaceIds: ['ws1', 'ws2'], archivedSessionIds: archived },
    tables: { workspaces },
  }), 'utf8')
  writeFileSync(join(home, 'storages', 'session_projcache.json'), JSON.stringify({
    unit: { name: 'session_projcache', version: 3 },
    global: null,
    tables: { sessions },
  }), 'utf8')
}

function seedPerRecord(home: string, id: string, record: unknown): void {
  const dir = join(home, 'storages', 'session_projcache', 'sessions')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${id}.json`), JSON.stringify({ version: 7, record }), 'utf8')
}

function record(title: unknown, createdAt: number, lastPromptAt: number, extraRows: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    identity: { formatVersion: 4, createdAt, cwd: 'C:\\work\\project', isSeeded: false },
    rows: {
      title: { ver: 1, seq: 1, val: title },
      sessionListMetadata: { ver: 1, seq: 1, val: { blank: false, lastPromptAt } },
      ...extraRows,
    },
  }
}

describe('listWorkspaceSessions', () => {
  test('groups legacy conversations by workspace with titles, newest first', () => {
    const home = tempHome()
    process.env.DSH_HOME = home
    seed(home,
      {
        ws1: {
          path: 'C:\\Users\\me\\ProjA',
          title: 'ProjA',
          sessionIds: ['session-aaa-1', 'session-aaa-2'],
        },
        ws2: {
          path: 'C:\\Users\\me\\ProjB',
          title: null,
          sessionIds: ['session-bbb-1'],
        },
      },
      {
        'session-aaa-1': {
          identity: { createdAt: 1000, cwd: 'C:\\Users\\me\\ProjA' },
          rows: { title: { ver: 1, seq: 1, val: '重构 auth.ts' } },
        },
        'session-aaa-2': {
          identity: { createdAt: 2000, cwd: 'C:\\Users\\me\\ProjA' },
          rows: { title: { ver: 1, seq: 1, val: null } },
        },
        'session-bbb-1': {
          identity: { createdAt: 500, cwd: 'C:\\Users\\me\\ProjB' },
          rows: { title: { ver: 1, seq: 1, val: '写 README' } },
        },
      },
    )

    const result = listWorkspaceSessions()
    const a = result.find((w) => w.cwd === 'C:\\Users\\me\\ProjA')
    expect(a).toBeDefined()
    expect(a!.label).toBe('ProjA')
    expect(a!.sessions.map((s) => s.id)).toEqual(['session-aaa-2', 'session-aaa-1'])
    expect(a!.sessions[1].title).toBe('重构 auth.ts')
    expect(a!.sessions[0].title).toBeNull()
    expect(result[0].cwd).toBe('C:\\Users\\me\\ProjA')
  })

  test('reads per-record caches without the legacy single file and restores activity order', () => {
    const home = tempHome()
    process.env.DSH_HOME = home
    seed(home, {
      ws1: { path: 'C:\\work\\old', title: 'Old workspace', sessionIds: ['session-old', 'session-new'] },
      ws2: { path: 'C:\\work\\latest', title: 'Latest workspace', sessionIds: ['session-latest'] },
    }, {})
    rmSync(join(home, 'storages', 'session_projcache.json'))
    seedPerRecord(home, 'session-old', record('旧任务', 1000, 2000))
    seedPerRecord(home, 'session-new', record('新任务', 1500, 5000))
    seedPerRecord(home, 'session-latest', record('最近任务', 1200, 6000))

    const result = listWorkspaceSessions()
    expect(result.map((w) => w.cwd)).toEqual(['C:\\work\\latest', 'C:\\work\\old'])
    expect(result[1].sessions.map((s) => s.id)).toEqual(['session-new', 'session-old'])
    expect(result[1].sessions[0]).toEqual({ id: 'session-new', title: '新任务', lastModified: 5000 })
  })

  test('prefers current per-record data over stale legacy entries', () => {
    const home = tempHome()
    process.env.DSH_HOME = home
    seed(home,
      { ws1: { path: 'C:\\work\\project', title: null, sessionIds: ['session-current'] } },
      { 'session-current': record('旧标题', 1000, 2000) },
    )
    seedPerRecord(home, 'session-current', record('新标题', 1000, 9000))

    expect(listWorkspaceSessions()[0].sessions[0]).toEqual({
      id: 'session-current', title: '新标题', lastModified: 9000,
    })
  })

  test('falls back to legacy data when a per-record file is malformed', () => {
    const home = tempHome()
    process.env.DSH_HOME = home
    seed(home,
      { ws1: { path: 'C:\\work\\project', title: null, sessionIds: ['session-current', 'session-healthy'] } },
      {
        'session-current': record('旧布局回退', 1000, 2000),
        'session-healthy': record('健康会话', 1000, 3000),
      },
    )
    const file = join(home, 'storages', 'session_projcache', 'sessions', 'session-current.json')
    mkdirSync(join(home, 'storages', 'session_projcache', 'sessions'), { recursive: true })
    writeFileSync(file, '{ broken', 'utf8')

    const sessions = listWorkspaceSessions()[0].sessions
    expect(sessions.map((s) => s.title)).toEqual(['健康会话', '旧布局回退'])
  })

  test('uses a bounded first-prompt label when the title is absent', () => {
    const home = tempHome()
    process.env.DSH_HOME = home
    seed(home,
      { ws1: { path: 'C:\\work\\project', title: null, sessionIds: ['session-prompt', 'session-empty'] } },
      {},
    )
    seedPerRecord(home, 'session-prompt', record(null, 1000, 2000, {
      titleInput: { ver: 3, seq: 1, val: { first: { text: `  第一行\n第二行 ${'长'.repeat(100)}` } } },
    }))
    seedPerRecord(home, 'session-empty', record('  ', 1000, 1000, {
      titleInput: { ver: 3, seq: 1, val: { first: { text: ' \n ' } } },
    }))

    const sessions = listWorkspaceSessions()[0].sessions
    expect(sessions[0].title).toMatch(/^第一行 第二行/)
    expect(sessions[0].title!.length).toBe(81)
    expect(sessions[0].title!.endsWith('…')).toBe(true)
    expect(sessions[1].title).toBeNull()
  })

  test('lowtide task sessions are excluded', () => {
    const home = tempHome()
    process.env.DSH_HOME = home
    seed(home,
      {
        ws1: {
          path: 'C:\\Users\\me\\ProjA',
          title: 'ProjA',
          sessionIds: ['session-real-1', 'lt-lt-foo-123', 'ns-ns-bar-456'],
        },
      },
      {
        'session-real-1': { identity: { createdAt: 1, cwd: 'C:\\Users\\me\\ProjA' }, rows: {} },
        'lt-lt-foo-123': { identity: { createdAt: 2, cwd: 'C:\\Users\\me\\ProjA' }, rows: {} },
        'ns-ns-bar-456': { identity: { createdAt: 3, cwd: 'C:\\Users\\me\\ProjA' }, rows: {} },
      },
    )
    expect(listWorkspaceSessions()[0].sessions.map((s) => s.id)).toEqual(['session-real-1'])
  })

  test('blank sessions in the per-record layout are excluded', () => {
    const home = tempHome()
    process.env.DSH_HOME = home
    seed(home,
      { ws1: { path: 'C:\\work\\project', title: null, sessionIds: ['session-used', 'session-blank'] } },
      {},
    )
    seedPerRecord(home, 'session-used', record('可续接', 1000, 1000))
    seedPerRecord(home, 'session-blank', {
      identity: { createdAt: 2000 },
      rows: { sessionListMetadata: { ver: 1, seq: 1, val: { blank: true, lastPromptAt: null } } },
    })

    expect(listWorkspaceSessions()[0].sessions.map((s) => s.id)).toEqual(['session-used'])
  })

  test('archived sessions are excluded', () => {
    const home = tempHome()
    process.env.DSH_HOME = home
    seed(home,
      { ws1: { path: 'C:\\work\\project', title: null, sessionIds: ['session-live', 'session-archived'] } },
      {},
      ['session-archived'],
    )
    seedPerRecord(home, 'session-live', record('正常', 1000, 1000))
    seedPerRecord(home, 'session-archived', record('归档', 2000, 2000))

    expect(listWorkspaceSessions()[0].sessions.map((s) => s.id)).toEqual(['session-live'])
  })

  test('applies the per-workspace limit after sorting per-record sessions', () => {
    const home = tempHome()
    process.env.DSH_HOME = home
    const ids = Array.from({ length: 35 }, (_, i) => `session-${i}`)
    seed(home, { ws1: { path: 'C:\\work\\project', title: null, sessionIds: ids } }, {})
    ids.forEach((id, i) => seedPerRecord(home, id, record(`任务 ${i}`, i, i)))

    const sessions = listWorkspaceSessions()[0].sessions
    expect(sessions).toHaveLength(30)
    expect(sessions[0].id).toBe('session-34')
    expect(sessions[29].id).toBe('session-5')
  })

  test('unsafe session ids never escape the per-record cache directory', () => {
    const home = tempHome()
    process.env.DSH_HOME = home
    const outside = join(home, 'storages', 'session_projcache', 'escape.json')
    mkdirSync(join(home, 'storages', 'session_projcache'), { recursive: true })
    writeFileSync(outside, JSON.stringify({ version: 7, record: record('不应读取', 1, 1) }), 'utf8')
    seed(home,
      { ws1: { path: 'C:\\work\\project', title: null, sessionIds: ['../escape'] } },
      {},
    )

    expect(listWorkspaceSessions()[0].sessions[0]).toEqual({ id: '../escape', title: null, lastModified: 0 })
  })

  test('missing or malformed storage files yield an empty list', () => {
    const home = tempHome()
    process.env.DSH_HOME = home
    expect(listWorkspaceSessions()).toEqual([])
    writeFileSync(join(home, 'storages', 'workspace.json'), '{ broken', 'utf8')
    expect(listWorkspaceSessions()).toEqual([])
  })
})
