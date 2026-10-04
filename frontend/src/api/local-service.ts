import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'
import {
  applyWorkPermitAction,
  listWorkPermits,
  overdueOpenWorkPermits,
  PERMIT_FIELD_DEADLINE,
  PERMIT_FIELD_DUE_STATE,
  PERMIT_KEY,
  summarizeWorkPermits,
} from '@/data/work-permit'

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

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  // 工作票列表统一经过时限口径补列，页面和到期统计拿到的许可时间是同一套。
  const rows = key === PERMIT_KEY ? listWorkPermits(listRows(key)) : listRows(key)
  const matched = filterRows(rows, filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const rows = listRows(key)

  // 工作票的签发/终结/作废走统一入口：许可时间只在首次签发时写一遍，
  // 重复提交签发不覆盖；终结时间在办理终结时写入。
  if (key === PERMIT_KEY) {
    const result = applyWorkPermitAction(rows, id, action)
    if (!result.ok || !result.row) {
      return { ok: result.ok, message: result.message }
    }
    const index = rows.findIndex((row) => Number(row.id) === id)
    const next = [...rows]
    next[index] = result.row
    saveRows(key, next)
    return { ok: true, message: result.message }
  }

  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
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

function csvCell(value: unknown): string {
  const text = String(value ?? '')
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  if (key === PERMIT_KEY) {
    // 导出与列表、统计共用 enrichWorkPermit 这同一段时限计算，
    // 不再拿终结时间另倒推一遍 —— 列表里正常的票导出不会再变超期。
    const extraFields = [PERMIT_FIELD_DEADLINE, PERMIT_FIELD_DUE_STATE]
    const header = ['编号', ...meta.fields, ...extraFields, '当前状态']
    const lines = [header.join(',')]
    for (const row of listWorkPermits(listRows(key))) {
      lines.push(
        [
          row.id,
          ...meta.fields.map((field) => csvCell(row[field])),
          ...extraFields.map((field) => csvCell(row[field])),
          csvCell(row.status),
        ].join(','),
      )
    }
    return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
  }
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => csvCell(row[field])), row.status].join(','))
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

// 工作票到期统计：与列表、导出同取 permitDeadlineInfo，工作负责人在两处
// 读到的许可时间不会再出现两套。
export function workPermitStats() {
  return summarizeWorkPermits(listRows(PERMIT_KEY))
}

// 超期未终结的工作票：主变检修「待开工清单」由此驱动。
export function pendingStartDrivenPermits(): EntryRow[] {
  return overdueOpenWorkPermits(listRows(PERMIT_KEY))
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
