import type { EntryRow } from './types'

// 工作票许可时限的唯一口径：
// 签发、到期统计、导出三处都只能从这里取数，不再各自算一遍。
export const PERMIT_KEY = 'workpermit'
export const PERMIT_VALID_HOURS = 24

export const PERMIT_STATUS_DRAFT = '待签发'
export const PERMIT_STATUS_PERMITTED = '已许可'
export const PERMIT_STATUS_FINISHED = '已终结'
export const PERMIT_STATUS_VOID = '已作废'
export const PERMIT_TERMINAL_STATUSES = [PERMIT_STATUS_FINISHED, PERMIT_STATUS_VOID]

export const PERMIT_FIELD_NO = '工作票号'
export const PERMIT_FIELD_TASK = '工作任务'
export const PERMIT_FIELD_STATION = '所属变电站'
export const PERMIT_FIELD_RANGE = '停电范围'
export const PERMIT_FIELD_OWNER = '工作负责人'
export const PERMIT_FIELD_PERMIT_AT = '许可时间'
export const PERMIT_FIELD_FINISH_AT = '终结时间'

// 列表与导出共用的追加列
export const PERMIT_FIELD_DEADLINE = '许可时限'
export const PERMIT_FIELD_DUE_STATE = '到期状态'

// 存量票回填许可时间的起点与步长（仅用于历史票，按签发次序逐个排）。
const BACKFILL_ANCHOR = Date.parse('2026-09-01T08:00:00')
const BACKFILL_STEP_MS = 60 * 60 * 1000

export function parseMoment(value: unknown): number | null {
  if (value === null || value === undefined) return null
  const text = String(value).trim()
  if (!text) return null
  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(text) ? `${text}T00:00:00` : text
  const time = Date.parse(normalized.replace(' ', 'T'))
  return Number.isNaN(time) ? null : time
}

export function formatMoment(time: number | null): string {
  if (time === null) return ''
  const d = new Date(time)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export type DeadlineInfo = {
  // 已终结/已作废的历史票沿用当时口径（由终结时间倒推），其余票以许可时间为基准。
  basis: 'permit' | 'legacy' | 'none'
  permitAt: number | null
  deadlineAt: number | null
  overdue: boolean
  overdueHours: number
}

/**
 * 全系统唯一的时限计算入口：
 * - 进行中（已许可）：许可时限 = 许可时间 + 固定小时数，超过当前时刻即超期。
 * - 已终结/已作废：沿用当时口径，许可时限由终结时间倒推，不参与超期判断。
 * - 待签发：尚未许可，不存在许可时限。
 */
export function permitDeadlineInfo(row: EntryRow, now: number = Date.now()): DeadlineInfo {
  const status = String(row.status)
  const permitAt = parseMoment(row[PERMIT_FIELD_PERMIT_AT])
  if (status === PERMIT_STATUS_DRAFT) {
    return { basis: 'none', permitAt, deadlineAt: null, overdue: false, overdueHours: 0 }
  }
  if (PERMIT_TERMINAL_STATUSES.includes(status)) {
    const finishAt = parseMoment(row[PERMIT_FIELD_FINISH_AT])
    return {
      basis: 'legacy',
      permitAt,
      deadlineAt: finishAt === null ? null : finishAt - PERMIT_VALID_HOURS * 3600_000,
      overdue: false,
      overdueHours: 0,
    }
  }
  const deadlineAt = permitAt === null ? null : permitAt + PERMIT_VALID_HOURS * 3600_000
  const overdue = deadlineAt !== null && now > deadlineAt
  return {
    basis: 'permit',
    permitAt,
    deadlineAt,
    overdue,
    overdueHours: overdue ? Math.max(0, Math.floor((now - (deadlineAt as number)) / 3600_000)) : 0,
  }
}

export function dueStateLabel(row: EntryRow, now: number = Date.now()): string {
  const status = String(row.status)
  if (status === PERMIT_STATUS_DRAFT) return PERMIT_STATUS_DRAFT
  if (PERMIT_TERMINAL_STATUSES.includes(status)) return '已闭环'
  const info = permitDeadlineInfo(row, now)
  if (info.deadlineAt === null) return '许可时间缺失'
  return info.overdue ? `超期${info.overdueHours}小时` : '许可有效期内'
}

/** 给列表/统计/导出统一补充许可时限与到期状态，保证三处读到的是同一个结果。 */
export function enrichWorkPermit(row: EntryRow, now: number = Date.now()): EntryRow {
  const info = permitDeadlineInfo(row, now)
  return {
    ...row,
    [PERMIT_FIELD_DEADLINE]: formatMoment(info.deadlineAt),
    [PERMIT_FIELD_DUE_STATE]: dueStateLabel(row, now),
  }
}

export function listWorkPermits(rows: EntryRow[], now: number = Date.now()): EntryRow[] {
  return rows.map((row) => enrichWorkPermit(row, now))
}

/**
 * 存量回填：已签发但许可时间缺失的票，按签发次序（id 升序）补齐许可时间。
 * 只补空值、绝不覆盖既有记录；待签发票不补；重复执行结果不变。
 * 返回的 changed 标记用于决定是否落盘。
 */
export function backfillPermitTimes(rows: EntryRow[]): { rows: EntryRow[]; changed: boolean } {
  const missing = rows
    .filter(
      // 已流转（已许可/已终结/已作废）却缺许可时间的存量票，按签发次序补齐。
      (row) =>
        String(row.status) !== PERMIT_STATUS_DRAFT &&
        parseMoment(row[PERMIT_FIELD_PERMIT_AT]) === null,
    )
    .sort((a, b) => Number(a.id) - Number(b.id))
  if (missing.length === 0) return { rows, changed: false }
  const fillById = new Map<number, string>()
  missing.forEach((row, index) => {
    fillById.set(Number(row.id), formatMoment(BACKFILL_ANCHOR + index * BACKFILL_STEP_MS))
  })
  return {
    rows: rows.map((row) => {
      const filled = fillById.get(Number(row.id))
      return filled ? { ...row, [PERMIT_FIELD_PERMIT_AT]: filled } : row
    }),
    changed: true,
  }
}

/** 超期且未终结的工作票 —— 主变检修「待开工清单」的唯一驱动来源。 */
export function overdueOpenWorkPermits(rows: EntryRow[], now: number = Date.now()): EntryRow[] {
  return listWorkPermits(rows, now)
    .filter((row) => {
      const status = String(row.status)
      return (
        status !== PERMIT_STATUS_DRAFT &&
        !PERMIT_TERMINAL_STATUSES.includes(status) &&
        permitDeadlineInfo(row, now).overdue
      )
    })
    .sort((a, b) => {
      const da = permitDeadlineInfo(a, now).deadlineAt ?? 0
      const db = permitDeadlineInfo(b, now).deadlineAt ?? 0
      return da - db
    })
}

export type WorkPermitSummary = {
  draft: number
  permitted: number
  finished: number
  overdueOpen: number
}

export function summarizeWorkPermits(rows: EntryRow[], now: number = Date.now()): WorkPermitSummary {
  const summary: WorkPermitSummary = { draft: 0, permitted: 0, finished: 0, overdueOpen: 0 }
  for (const row of rows) {
    const status = String(row.status)
    if (status === PERMIT_STATUS_DRAFT) summary.draft += 1
    else if (status === PERMIT_STATUS_PERMITTED) summary.permitted += 1
    else if (status === PERMIT_STATUS_FINISHED) summary.finished += 1
    if (permitDeadlineInfo(row, now).overdue) summary.overdueOpen += 1
  }
  return summary
}

export type WorkPermitActionResult = {
  ok: boolean
  message: string
  row?: EntryRow
}

/**
 * 工作票动作的统一入口：
 * - 签发许可只允许「待签发 → 已许可」，许可时间在签发时一次性写入；
 *   同一张票重复提交签发只算一遍，不覆盖既有许可时间。
 * - 办理终结只允许「已许可 → 已终结」，写入终结时间。
 * - 作废只允许非终态票操作。
 */
export function applyWorkPermitAction(
  rows: EntryRow[],
  id: number,
  action: string,
  now: number = Date.now(),
): WorkPermitActionResult {
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的工作票` }
  }
  const current = rows[index]
  const status = String(current.status)

  if (action === '签发许可') {
    if (status === PERMIT_STATUS_PERMITTED) {
      return { ok: false, message: '工作票已签发许可，重复提交只按一遍计，许可时间不变' }
    }
    if (status !== PERMIT_STATUS_DRAFT) {
      return { ok: false, message: `当前为「${status}」，不能再签发许可` }
    }
    const existingAt = current[PERMIT_FIELD_PERMIT_AT]
    const permitAt = parseMoment(existingAt) === null ? formatMoment(now) : String(existingAt)
    const row: EntryRow = {
      ...current,
      status: PERMIT_STATUS_PERMITTED,
      pending: true,
      abnormal: false,
      [PERMIT_FIELD_PERMIT_AT]: permitAt,
    }
    return { ok: true, message: `工作票已签发许可，许可时间 ${permitAt}`, row }
  }

  if (action === '办理终结') {
    if (status === PERMIT_STATUS_FINISHED) {
      return { ok: false, message: '工作票已终结，无需重复办理' }
    }
    if (status !== PERMIT_STATUS_PERMITTED) {
      return { ok: false, message: `当前为「${status}」，先签发许可后才能办理终结` }
    }
    const row: EntryRow = {
      ...current,
      status: PERMIT_STATUS_FINISHED,
      pending: false,
      abnormal: false,
      [PERMIT_FIELD_FINISH_AT]: formatMoment(now),
    }
    return { ok: true, message: '工作票已办理终结', row }
  }

  if (action === '作废工作票') {
    if (status === PERMIT_STATUS_VOID) {
      return { ok: false, message: '工作票已作废，无需重复操作' }
    }
    if (PERMIT_TERMINAL_STATUSES.includes(status)) {
      return { ok: false, message: '工作票已终结，不能作废' }
    }
    const row: EntryRow = { ...current, status: PERMIT_STATUS_VOID, pending: false, abnormal: true }
    return { ok: true, message: '工作票已作废', row }
  }

  return { ok: false, message: `工作票没有登记「${action}」这个动作` }
}
