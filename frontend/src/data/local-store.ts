import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'
import { migrateWorkPermits, WORKPERMIT_KEY } from './workpermit'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'substation-protection:entries'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

// 存量口径收拢：工作票许可时间在首次读取时按签发次序回填一遍，已终结的历史票沿用旧口径冻结。
// 迁移是幂等的（只补缺失、不覆盖），每次读都跑也安全，只有真改了数据才写回。
function applyMigrations(
  data: Record<string, EntryRow[]>,
): { data: Record<string, EntryRow[]>; changed: boolean } {
  if (!Array.isArray(data[WORKPERMIT_KEY])) {
    return { data, changed: false }
  }
  const before = JSON.stringify(data[WORKPERMIT_KEY])
  const migrated = migrateWorkPermits(data[WORKPERMIT_KEY])
  const after = JSON.stringify(migrated)
  if (after === before) {
    return { data, changed: false }
  }
  return { data: { ...data, [WORKPERMIT_KEY]: migrated }, changed: true }
}

function persist(data: Record<string, EntryRow[]>): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(data))
  }
}

function readStorage(): Record<string, EntryRow[]> {
  let fallback = clone(SEED_ROWS)
  if (typeof window === 'undefined' || !window.localStorage) {
    return applyMigrations(fallback).data
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    fallback = applyMigrations(fallback).data
    persist(fallback)
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    const { data: merged, changed } = applyMigrations({ ...fallback, ...parsed })
    if (changed) {
      persist(merged)
    }
    return merged
  } catch {
    fallback = applyMigrations(fallback).data
    persist(fallback)
    return fallback
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
