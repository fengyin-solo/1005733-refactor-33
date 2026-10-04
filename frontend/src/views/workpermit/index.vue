<template>
  <section class="page" data-module="workpermit">
    <header class="page-head">
      <div>
        <h2>工作票许可管理</h2>
        <p class="page-desc">维护工作票，围绕工作票号、工作任务、所属变电站、停电范围做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记工作票</button>
        <button class="btn" type="button" @click="exportRows">导出工作票许可清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in statCards" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value" :class="{ danger: item.danger }">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)" :class="{ 'row-overdue': isOverdue(row) }">
          <td v-for="column in columns" :key="column">{{ row[column] || '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无工作票许可数据，可先登记工作票</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条工作票许可记录</span>
      <span>许可时限统一按许可时间起算 {{ permitValidHours }} 小时；已终结历史票沿用当时口径</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
  workPermitStats,
} from '@/api/local-service'
import { PERMIT_VALID_HOURS } from '@/data/work-permit'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('workpermit')
// 许可时限、到期状态由统一口径在取数时补入，列表、统计、导出读到的是同一套值。
const columns = [
  '工作票号',
  '工作任务',
  '所属变电站',
  '停电范围',
  '工作负责人',
  '许可时间',
  '许可时限',
  '终结时间',
  '到期状态',
  '许可状态',
]
const actions = ['签发许可', '办理终结', '作废工作票']
const statuses = ['待签发', '已许可', '已终结', '已作废']
const permitValidHours = PERMIT_VALID_HOURS

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)

const statCards = computed(() => {
  const summary = workPermitStats()
  return [
    { label: '待签发工作票', value: summary.draft, danger: false },
    { label: '已许可工作票', value: summary.permitted, danger: false },
    { label: '已终结工作票', value: summary.finished, danger: false },
    { label: '超期未终结工作票', value: summary.overdueOpen, danger: summary.overdueOpen > 0 },
  ]
})

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function isOverdue(row: EntryRow): boolean {
  return String(row['到期状态'] ?? '').startsWith('超期')
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '工作票登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '工作票许可列表读取失败'
  }
}

onMounted(reload)
</script>

<style scoped>
.row-overdue {
  background-color: rgba(224, 76, 76, 0.08);
}

.stat-value.danger {
  color: #e04c4c;
}
</style>
