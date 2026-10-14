import { DEFAULT_PERSONAL_CAPACITY, parsePersonalCapacity, type PersonalCapacity } from './personalPlan'
const KEY = 'msz.learning.capacity.v1'
export function loadPersonalCapacity(): PersonalCapacity {
  try { const raw = localStorage.getItem(KEY); return raw ? parsePersonalCapacity(JSON.parse(raw)) : { ...DEFAULT_PERSONAL_CAPACITY } } catch { return { ...DEFAULT_PERSONAL_CAPACITY } }
}
export function savePersonalCapacity(value: PersonalCapacity): void { localStorage.setItem(KEY, JSON.stringify(parsePersonalCapacity(value))); window.dispatchEvent(new Event('msz:capacity-changed')) }
