import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'
import { backfillPermitTimes, PERMIT_KEY } from './work-permit'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'substation-protection:entries'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

// 存量数据兼容：把缺许可时间的工作票按签发次序回填一遍后落盘。
// 幂等，只补空值、不改既有记录。
function migrate(rows: Record<string, EntryRow[]>): Record<string, EntryRow[]> {
  const permits = rows[PERMIT_KEY]
  if (!permits) return rows
  const { rows: filled, changed } = backfillPermitTimes(permits)
  if (!changed) return rows
  const next = { ...rows, [PERMIT_KEY]: filled }
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
  return next
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = clone(SEED_ROWS)
  if (typeof window === 'undefined' || !window.localStorage) {
    return migrate(fallback)
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    const seeded = migrate(fallback)
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(seeded))
    return seeded
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    return migrate({ ...fallback, ...parsed })
  } catch {
    const seeded = migrate(fallback)
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(seeded))
    return seeded
  }
}

let cache: Record<string, EntryRow[]> | null = null

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  const next = { ...allRows(), [key]: rows }
  cache = next
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}
