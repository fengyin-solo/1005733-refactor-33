import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'
import {
  advancePermit,
  decorateWorkPermits,
  derivePendingMaintenance,
  TRANSFORMER_MAINT_KEY,
  WORKPERMIT_KEY,
  workPermitExport,
} from '@/data/workpermit'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

// 主变检修的待开工清单除了自身记录，还要并入「超出期限未终结」工作票派生的待开工条目。
export function moduleRows(key: string): EntryRow[] {
  if (key === TRANSFORMER_MAINT_KEY) {
    return [...listRows(TRANSFORMER_MAINT_KEY), ...derivePendingMaintenance(listRows(WORKPERMIT_KEY))]
  }
  return listRows(key)
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  // 工作票列表拿到的许可时限/到期判定，与统计、导出是同一段计算，不存在两套读法。
  const source =
    key === WORKPERMIT_KEY ? decorateWorkPermits(listRows(WORKPERMIT_KEY)) : moduleRows(key)
  const matched = filterRows(source, filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  // 主变检修里由超期工作票派生的待开工条目不落库，不允许在主变页直接操作。
  if (key === TRANSFORMER_MAINT_KEY && id > 900000) {
    return {
      ok: false,
      message: '该待开工条目由超期未终结的工作票驱动，请先回到工作票许可页终结对应工作票',
    }
  }
  // 工作票动作走统一时限口径：签发首盖许可时间、重复签发只算一遍、终结首盖终结时间。
  if (key === WORKPERMIT_KEY) {
    const { rows, result } = advancePermit(listRows(WORKPERMIT_KEY), id, action)
    if (result.ok) {
      saveRows(WORKPERMIT_KEY, rows)
    }
    return result
  }
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  // 工作票导出与列表、统计共用同一套装饰结果，同一张票不会在导出里变成另一套期限。
  if (key === WORKPERMIT_KEY) {
    return workPermitExport(listRows(WORKPERMIT_KEY))
  }
  const meta = moduleMeta(key)
  // 主变检修导出只落自身记录；超期工作票派生的待开工条目是实时视图，不进历史清单。
  const rows = key === TRANSFORMER_MAINT_KEY ? listRows(TRANSFORMER_MAINT_KEY) : moduleRows(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of rows) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
