'use client'

import { useCallback, useRef, useState } from 'react'

/**
 * Reorder a list by dragging a handle (mouse, pen, touch – only the handle captures,
 * so the page still scrolls normally) or by keyboard on the handle:
 * Space/Enter picks up and drops, arrows move, Escape cancels.
 */
export function useSortable(ids: string[], onCommit: (next: string[], prev: string[]) => void, announce: (msg: string) => void, labels: {
  picked: (pos: number, total: number) => string
  moved: (pos: number, total: number) => string
  dropped: (pos: number) => string
  cancelled: string
}) {
  const [draft, setDraft] = useState<string[] | null>(null)
  const [active, setActive] = useState<string | null>(null)
  const [mode, setMode] = useState<'pointer' | 'keyboard' | null>(null)
  const rows = useRef(new Map<string, HTMLElement>())
  const start = useRef<string[]>([])
  const order = draft ?? ids

  const register = useCallback((id: string) => (el: HTMLElement | null) => {
    if (el) rows.current.set(id, el); else rows.current.delete(id)
  }, [])

  const finish = useCallback((commit: boolean, final?: string[]) => {
    const prev = start.current
    const next = final ?? prev
    setDraft(null); setActive(null); setMode(null)
    if (commit && next.join() !== prev.join()) onCommit(next, prev)
  }, [onCommit])

  const onPointerDown = useCallback((id: string) => (e: React.PointerEvent) => {
    if (e.button > 0 || mode === 'keyboard') return
    e.preventDefault()
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    start.current = ids
    let current = ids
    let moved = false
    const startY = e.clientY
    const move = (ev: PointerEvent) => {
      if (!moved && Math.abs(ev.clientY - startY) < 4) return
      if (!moved) { moved = true; setActive(id); setMode('pointer'); document.body.style.userSelect = 'none' }
      // target slot: first row whose midpoint is below the pointer
      const others = current.filter((x) => x !== id)
      let slot = others.length
      for (let i = 0; i < others.length; i++) {
        const r = rows.current.get(others[i])?.getBoundingClientRect()
        if (r && ev.clientY < r.top + r.height / 2) { slot = i; break }
      }
      const next = [...others.slice(0, slot), id, ...others.slice(slot)]
      if (next.join() !== current.join()) { current = next; setDraft(next) }
    }
    const end = (ev: PointerEvent) => {
      removeEventListener('pointermove', move); removeEventListener('pointerup', end); removeEventListener('pointercancel', end)
      document.body.style.userSelect = ''
      // a browser-cancelled gesture never saves
      if (moved) finish(ev.type === 'pointerup', current); else { setActive(null); setMode(null) }
    }
    addEventListener('pointermove', move); addEventListener('pointerup', end); addEventListener('pointercancel', end)
  }, [ids, mode, finish])

  const onKeyDown = useCallback((id: string) => (e: React.KeyboardEvent) => {
    const picked = mode === 'keyboard' ? active : null
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault()
      if (!picked) {
        start.current = ids
        setDraft(ids); setActive(id); setMode('keyboard')
        announce(labels.picked(ids.indexOf(id) + 1, ids.length))
      } else {
        const final = order
        announce(labels.dropped(final.indexOf(picked) + 1))
        finish(true, final)
      }
    } else if (picked && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault()
      const i = order.indexOf(picked)
      const j = i + (e.key === 'ArrowUp' ? -1 : 1)
      if (j < 0 || j >= order.length) return
      const next = [...order]; [next[i], next[j]] = [next[j], next[i]]
      setDraft(next)
      announce(labels.moved(j + 1, next.length))
    } else if (picked && e.key === 'Escape') {
      e.preventDefault(); e.stopPropagation()
      announce(labels.cancelled)
      finish(false)
    }
  }, [mode, active, ids, order, announce, labels, finish])

  return { order, active, mode, register, onPointerDown, onKeyDown }
}
