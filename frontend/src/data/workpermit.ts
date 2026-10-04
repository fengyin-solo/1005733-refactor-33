import type { ActionResult, EntryRow } from './types'

// 工作票许可时限的唯一口径：
// 签发入口、到期统计、清单导出都只允许从本文件取数，禁止各写一套加减时间。
export const WORKPERMIT_KEY = 'workpermit'
export const TRANSFORMER_MAINT_KEY = 'transformermaint'

// 许可有效期固定小时数：许可时限 = 许可时间 + PERMIT_VALID_HOURS。
export const PERMIT_VALID_HOURS = 24

export const GRANTED_FIELD = '许可时间'
export const CLOSED_FIELD = '终结时间'
export const DEADLINE_FIELD = '许可时限'
export const VERDICT_FIELD = '到期判定'
// 已经终结的历史票会带上这个标记：它们沿用当时的倒推口径（终结时间 - 固定小时数），冻结不改。
export const LEGACY_FIELD = '时限口径'
export const LEGACY_CLOSED = '历史终结'

export const STATUS_DRAFT = '待签发'
export const STATUS_GRANTED = '已许可'
export const STATUS_CLOSED = '已终结'
export const STATUS_VOID = '已作废'

// 列表与导出共用同一套列、同一份装饰结果，保证「列表正常、导出超期」不可能再发生。
export const PERMIT_FIELDS = [
  '工作票号',
  '工作任务',
  '所属变电站',
  '停电范围',
  '工作负责人',
  GRANTED_FIELD,
  DEADLINE_FIELD,
  CLOSED_FIELD,
  VERDICT_FIELD,
  '许可状态',
]

export const VERDICT_DRAFT = '待签发'
export const VERDICT_IN_SCOPE = '期限内'
export const VERDICT_OVERDUE = '已超期'
export const VERDICT_CLOSED = '已终结'
export const VERDICT_VOID = '已作废'
export const VERDICT_NOT_STARTED = '未起算'

const pad = (value: number): string => String(value).padStart(2, '0')

export function formatDateTime(value: Date): string {
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())} ${pad(
    value.getHours(),
  )}:${pad(value.getMinutes())}`
}

// 同时认旧数据里的「YYYY-MM-DD」和签发时写入的「YYYY-MM-DD HH:mm」，统一按本地时区解析。
export function parseDateTime(value: unknown): Date | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value
  }
  if (typeof value !== 'number' && typeof value !== 'string') {
    return null
  }
  const text = String(value).trim()
  if (!text) {
    return null
  }
  let match = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?$/)
  if (match) {
    return new Date(
      Number(match[1]),
      Number(match[2]) - 1,
      Number(match[3]),
      Number(match[4]),
      Number(match[5]),
      match[6] ? Number(match[6]) : 0,
    )
  }
  match = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/)
  if (match) {
    return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  }
  const fallback = new Date(text)
  return Number.isNaN(fallback.getTime()) ? null : fallback
}

function addHours(value: Date, hours: number): Date {
  return new Date(value.getTime() + hours * 60 * 60 * 1000)
}

// 许可时间的唯一读入口：工作负责人列表、到期统计、导出都从这个字段读，不再有第二套。
export function permitGrantedAt(row: EntryRow): Date | null {
  return parseDateTime(row[GRANTED_FIELD])
}

// 许可时限的唯一算法。
// 唯一例外：迁移前就已经终结的历史票，沿用当时「终结时间倒推」的口径并冻结。
export function permitDeadline(row: EntryRow): { at: Date | null; legacy: boolean } {
  if (row[LEGACY_FIELD] === LEGACY_CLOSED) {
    const closedAt = parseDateTime(row[CLOSED_FIELD])
    if (closedAt) {
      return { at: addHours(closedAt, -PERMIT_VALID_HOURS), legacy: true }
    }
  }
  const grantedAt = permitGrantedAt(row)
  return grantedAt ? { at: addHours(grantedAt, PERMIT_VALID_HOURS), legacy: false } : { at: null, legacy: false }
}

export type PermitVerdict = {
  deadline: Date | null
  label: string
  expired: boolean
}

export function permitVerdict(row: EntryRow, now: Date = new Date()): PermitVerdict {
  const status = String(row.status ?? '')
  if (status === STATUS_DRAFT) {
    return { deadline: null, label: VERDICT_DRAFT, expired: false }
  }
  if (status === STATUS_VOID) {
    return { deadline: null, label: VERDICT_VOID, expired: false }
  }
  const { at: deadline } = permitDeadline(row)
  if (status === STATUS_CLOSED) {
    return { deadline, label: VERDICT_CLOSED, expired: false }
  }
  if (status === STATUS_GRANTED) {
    if (!deadline) {
      return { deadline: null, label: VERDICT_NOT_STARTED, expired: false }
    }
    return now.getTime() > deadline.getTime()
      ? { deadline, label: VERDICT_OVERDUE, expired: true }
      : { deadline, label: VERDICT_IN_SCOPE, expired: false }
  }
  return { deadline, label: status || VERDICT_DRAFT, expired: false }
}

// 列表、统计、导出共用：同一张票在任何地方看到的许可时限与到期判定都来自这里。
export function decorateWorkPermits(rows: EntryRow[], now: Date = new Date()): EntryRow[] {
  return rows.map((row) => {
    const verdict = permitVerdict(row, now)
    const status = String(row.status ?? '')
    return {
      ...row,
      [DEADLINE_FIELD]: verdict.deadline ? formatDateTime(verdict.deadline) : '—',
      [VERDICT_FIELD]: verdict.label,
      pending: status === STATUS_DRAFT || status === STATUS_GRANTED,
      abnormal: Boolean(row.abnormal) || verdict.expired,
    }
  })
}

export function overdueOpenPermits(rows: EntryRow[], now: Date = new Date()): EntryRow[] {
  return decorateWorkPermits(rows, now).filter((row) => row[VERDICT_FIELD] === VERDICT_OVERDUE)
}

// 超出期限未终结的工作票，直接驱动主变检修的待开工清单（派生条目，不落库、不可重复操作）。
export function derivePendingMaintenance(rows: EntryRow[], now: Date = new Date()): EntryRow[] {
  return overdueOpenPermits(rows, now).map((row) => {
    const station = String(row['所属变电站'] ?? '关联变电站')
    return {
      id: Number(row.id) + 900000,
      status: '待开工',
      pending: true,
      abnormal: true,
      检修编号: `WP-${String(row['工作票号'] ?? row.id)}`,
      主变名称: `${station}主变`,
      检修类别: '工作票超期未终结待核查',
      停电范围: row['停电范围'] ?? '',
      检修班组: row['工作负责人'] ?? '',
      计划工期: `许可截止 ${String(row[DEADLINE_FIELD] ?? '')}`,
      完成日期: '',
      检修状态: '待开工',
      来源: '工作票超期驱动',
    }
  })
}

// 存量数据一次性回填（幂等）：
// 1. 已终结的历史票：缺许可时间就按当时口径从终结时间倒推，并冻结为历史口径；
// 2. 已许可但缺许可时间的：按签发次序（id 升序）依次回填，间隔一个许可有效期；
// 3. 已存在且可解析的许可时间一律不覆盖。
export function migrateWorkPermits(input: EntryRow[]): EntryRow[] {
  const rows = [...input]
    .sort((a, b) => Number(a.id) - Number(b.id))
    .map((row) => ({ ...row }))
  let cursor = backfillAnchor(rows)
  for (const row of rows) {
    const status = String(row.status ?? '')
    if (status === STATUS_CLOSED) {
      if (!parseDateTime(row[GRANTED_FIELD])) {
        const closedAt = parseDateTime(row[CLOSED_FIELD])
        if (closedAt) {
          row[GRANTED_FIELD] = formatDateTime(addHours(closedAt, -PERMIT_VALID_HOURS))
        }
      }
      row[LEGACY_FIELD] = LEGACY_CLOSED
      const grantedAt = parseDateTime(row[GRANTED_FIELD])
      if (grantedAt) {
        const edge = addHours(grantedAt, PERMIT_VALID_HOURS)
        if (edge.getTime() > cursor.getTime()) {
          cursor = edge
        }
      }
    } else if (status === STATUS_GRANTED && !parseDateTime(row[GRANTED_FIELD])) {
      row[GRANTED_FIELD] = formatDateTime(cursor)
      cursor = addHours(cursor, PERMIT_VALID_HOURS)
    }
  }
  return rows
}

function backfillAnchor(rows: EntryRow[]): Date {
  let earliest: Date | null = null
  const consider = (value: Date | null) => {
    if (value && (!earliest || value.getTime() < earliest.getTime())) {
      earliest = value
    }
  }
  for (const row of rows) {
    consider(parseDateTime(row[GRANTED_FIELD]))
    const closedAt = parseDateTime(row[CLOSED_FIELD])
    // 已终结票当时是从终结时间倒推许可时间的，回填起点要按倒推出的许可时间算，不能晚于它。
    if (closedAt && String(row.status ?? '') === STATUS_CLOSED) {
      consider(addHours(closedAt, -PERMIT_VALID_HOURS))
    }
  }
  return earliest ?? new Date(2026, 8, 1, 8, 0)
}

// 签发/终结/作废动作：同一张票重复提交签发只算一遍，许可时间不会被第二次提交改写。
export function advancePermit(
  source: EntryRow[],
  id: number,
  action: string,
  now: Date = new Date(),
): { rows: EntryRow[]; result: ActionResult } {
  const rows = [...source]
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { rows, result: { ok: false, message: `没有找到编号为 ${id} 的工作票` } }
  }
  const current = { ...rows[index] }
  const status = String(current.status ?? '')

  const fail = (message: string) => ({ rows, result: { ok: false, message } })
  const commit = (next: EntryRow, message: string) => {
    rows[index] = next
    return { rows, result: { ok: true, message } }
  }

  if (action === '签发许可') {
    if (status === STATUS_GRANTED) {
      return fail('该工作票已签发许可，重复提交只按一遍计，许可时间保持不变')
    }
    if (status !== STATUS_DRAFT) {
      return fail(`工作票当前为「${status}」，不能再签发许可`)
    }
    // 只在首次签发时写入许可时间；已有的合法许可时间保留，绝不重盖时间戳。
    if (!parseDateTime(current[GRANTED_FIELD])) {
      current[GRANTED_FIELD] = formatDateTime(now)
    }
    return commit(
      { ...current, status: STATUS_GRANTED, pending: true, abnormal: false },
      `工作票已签发许可，许可时间 ${current[GRANTED_FIELD]}，许可时限按统一口径计算`,
    )
  }

  if (action === '办理终结') {
    if (status === STATUS_CLOSED) {
      return fail('工作票已经终结，不用重复操作')
    }
    if (status !== STATUS_GRANTED) {
      return fail(`工作票当前为「${status}」，只有已许可的工作票能办理终结`)
    }
    return commit(
      { ...current, status: STATUS_CLOSED, pending: false, [CLOSED_FIELD]: formatDateTime(now) },
      '工作票已办理终结',
    )
  }

  if (action === '作废工作票') {
    if (status === STATUS_VOID) {
      return fail('工作票已经作废，不用重复操作')
    }
    if (status === STATUS_CLOSED) {
      return fail('工作票已终结，不能作废')
    }
    return commit(
      { ...current, status: STATUS_VOID, pending: false, abnormal: true },
      '工作票已作废',
    )
  }

  return fail(`工作票没有登记「${action}」这个动作`)
}

// 导出与列表同源：装饰后的行、同样的列，导出里不可能再出现第二套时限。
export function workPermitExport(
  source: EntryRow[],
  now: Date = new Date(),
): { filename: string; content: string } {
  const decorated = decorateWorkPermits(source, now)
  const header = ['编号', ...PERMIT_FIELDS, '当前状态']
  const lines = [header.join(',')]
  for (const row of decorated) {
    lines.push([row.id, ...PERMIT_FIELDS.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: '工作票许可-清单.csv', content: `\uFEFF${lines.join('\n')}` }
}
