import type { HomeTask } from './homeView'
import type { ExperiencePreferences } from './experiencePreferences'

/** Presentation only: never changes capacity, schedule dates or the global plan. */
export function focusTask(tasks: readonly HomeTask[], mode: ExperiencePreferences['start']): HomeTask | undefined {
  return (mode === 'review' ? tasks.find((task) => task.type === 'review') : undefined) ?? tasks[0]
}
