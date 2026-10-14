import { useEffect, useState } from 'react'

/** Recompute local date at focus and minute boundaries without impure render reads. */
export function useLearningClock(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const update = () => setNow(Date.now())
    const interval = window.setInterval(update, 60_000)
    window.addEventListener('focus', update)
    return () => { window.clearInterval(interval); window.removeEventListener('focus', update) }
  }, [])
  return now
}
