import { useMemo } from 'react'
import { useDoc } from '../store/docStore'
import {
  collectTagTexts,
  computeFilter,
  isFilterActive,
  type StatusFilter,
} from '../lib/filter'
import { t, useT } from '../i18n'

const STATUS_KEYS: { value: StatusFilter; key: Parameters<typeof t>[0] }[] = [
  { value: '', key: 'filter.allStatus' },
  { value: 'todo', key: 'filter.todo' },
  { value: 'doing', key: 'filter.doing' },
  { value: 'done', key: 'filter.done' },
  { value: 'milestone', key: 'filter.milestone' },
]

/**
 * M11（PRD 4.1.7 P1）：画布过滤条。
 * 标签 + 任务状态两个维度（AND），仅显示命中分支（命中节点及其祖先链）；
 * 过滤是视图态，不写文档、不落盘，切换标签自动重置。
 */
export default function FilterBar() {
  const doc = useDoc((s) => s.doc)
  const filter = useDoc((s) => s.filter)
  const setFilter = useDoc((s) => s.setFilter)
  const clearFilter = useDoc((s) => s.clearFilter)
  const tr = useT()

  const tagTexts = useMemo(() => collectTagTexts(doc), [doc])
  const active = isFilterActive(filter)
  const shownCount = useMemo(() => {
    if (!active) return null
    // 不含根的可见节点数
    return computeFilter(doc, filter).shown.size - 1
  }, [doc, filter, active])

  return (
    <div className={'filter-bar' + (active ? ' active' : '')} role="group" aria-label="节点过滤">
      <span className="filter-icon" aria-hidden>
        ⌕
      </span>
      <select
        className="filter-select"
        aria-label="按标签过滤"
        value={filter.tag}
        onChange={(e) => setFilter({ tag: e.target.value })}
      >
        <option value="">{tr('filter.allTags')}</option>
        {tagTexts.map((t) => (
          <option key={t} value={t}>
            {t}
          </option>
        ))}
      </select>
      <select
        className="filter-select"
        aria-label="按状态过滤"
        value={filter.status}
        onChange={(e) => setFilter({ status: e.target.value as StatusFilter })}
      >
        {STATUS_KEYS.map((o) => (
          <option key={o.value} value={o.value}>
            {t(o.key)}
          </option>
        ))}
      </select>
      {active && (
        <>
          <span className="filter-count" aria-live="polite">
            {tr('filter.hitCount', { n: shownCount ?? 0 })}
          </span>
          <button className="filter-clear tbtn" onClick={clearFilter} title="清除过滤">
            {tr('common.clear')} ✕
          </button>
        </>
      )}
    </div>
  )
}
