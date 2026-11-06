'use client'

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

export interface MenuItem {
  label: string
  icon?: React.ReactNode
  onSelect: () => void
  danger?: boolean
  separatorBefore?: boolean
}

/** Small action menu: button + popover list; closes on outside click, Escape or selection. */
export function Menu({ label, trigger, items, align = 'right', className = '' }: {
  label: string
  trigger: React.ReactNode
  items: MenuItem[]
  align?: 'left' | 'right'
  className?: string
}) {
  const [open, setOpen] = useState(false)
  // fixed + hidden until placed: an unplaced list sits at the end of <body>, and focusing it
  // there scrolls the page down
  const [pos, setPos] = useState<React.CSSProperties>({ position: 'fixed', top: 0, left: 0, visibility: 'hidden' })
  const root = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const btn = useRef<HTMLButtonElement>(null)
  // rendered in a portal with fixed position, so scroll/overflow containers never clip it
  useLayoutEffect(() => {
    if (!open) { setPos({ position: 'fixed', top: 0, left: 0, visibility: 'hidden' }); return }
    if (!btn.current) return
    const place = () => {
      const r = btn.current!.getBoundingClientRect()
      const h = list.current?.offsetHeight ?? 240
      const up = r.bottom + h + 8 > window.innerHeight && r.top > h + 8
      setPos({
        position: 'fixed',
        top: up ? r.top - h - 4 : r.bottom + 4,
        ...(align === 'right' ? { right: Math.max(8, window.innerWidth - r.right) } : { left: Math.max(8, r.left) }),
      })
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true) }
  }, [open, align])
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      const n = e.target as Node
      if (!root.current?.contains(n) && !list.current?.contains(n)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); btn.current?.focus() } }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [open])
  // focus the first item once the list is placed (a hidden element cannot take focus)
  const placed = open && pos.visibility !== 'hidden'
  useEffect(() => {
    if (placed) list.current?.querySelector<HTMLButtonElement>('[role=menuitem]')?.focus({ preventScroll: true })
  }, [placed])
  const onListKey = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    e.preventDefault()
    const all = [...(list.current?.querySelectorAll<HTMLButtonElement>('[role=menuitem]') ?? [])]
    const i = all.indexOf(document.activeElement as HTMLButtonElement)
    all[(i + (e.key === 'ArrowDown' ? 1 : -1) + all.length) % all.length]?.focus()
  }
  return (
    <div ref={root} className={`relative ${className}`} onClick={(e) => e.stopPropagation()}>
      <button
        ref={btn}
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        {trigger}
      </button>
      {open && createPortal(
        <div
          ref={list}
          role="menu"
          aria-label={label}
          onKeyDown={onListKey}
          onClick={(e) => e.stopPropagation()}
          style={pos}
          className="z-[80] min-w-[210px] rounded-xl border border-border bg-card p-1.5 shadow-elevation-lg"
        >
          {items.map((it, i) => (
            <div key={i}>
              {it.separatorBefore && <div className="my-1 border-t border-border" />}
              <button
                type="button"
                role="menuitem"
                onClick={() => { setOpen(false); it.onSelect() }}
                className={`flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm hover:bg-accent focus:bg-accent focus:outline-none ${it.danger ? 'text-destructive' : ''}`}
              >
                {it.icon}
                {it.label}
              </button>
            </div>
          ))}
        </div>,
        document.body,
      )}
    </div>
  )
}
