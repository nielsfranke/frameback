'use client'

import { useEffect, useRef, useState } from 'react'

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
  const root = useRef<HTMLDivElement>(null)
  const btn = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false) }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); btn.current?.focus() } }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    root.current?.querySelector<HTMLButtonElement>('[role=menuitem]')?.focus()
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [open])
  const onListKey = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    e.preventDefault()
    const all = [...(root.current?.querySelectorAll<HTMLButtonElement>('[role=menuitem]') ?? [])]
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
      {open && (
        <div
          role="menu"
          onKeyDown={onListKey}
          className={`absolute top-full z-50 mt-1 min-w-[210px] rounded-xl border border-border bg-card p-1.5 shadow-elevation-lg ${align === 'right' ? 'right-0' : 'left-0'}`}
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
        </div>
      )}
    </div>
  )
}
