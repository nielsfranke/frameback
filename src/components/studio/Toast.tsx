'use client'

import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'

interface ToastData { id: number; text: string; undo?: () => void | Promise<void> }
const Ctx = createContext<(text: string, undo?: ToastData['undo']) => void>(() => {})

/** One toast at a time, bottom centre, with optional "Undo". Announced politely. */
export function ToastProvider({ children }: { children: React.ReactNode }) {
  const t = useTranslations('studio')
  const [toast, setToast] = useState<ToastData | null>(null)
  const seq = useRef(0)
  const show = useCallback((text: string, undo?: ToastData['undo']) => setToast({ id: ++seq.current, text, undo }), [])
  useEffect(() => {
    if (!toast) return
    const id = setTimeout(() => setToast((cur) => (cur?.id === toast.id ? null : cur)), toast.undo ? 8000 : 4000)
    return () => clearTimeout(id)
  }, [toast])
  return (
    <Ctx.Provider value={show}>
      {children}
      <div aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-5 z-[90] flex justify-center px-4">
        {toast && (
          <div className="pointer-events-auto flex max-w-xl items-center gap-4 rounded-xl bg-neutral-900 px-4 py-2.5 text-sm text-white shadow-elevation-lg animate-in fade-in slide-in-from-bottom-2">
            <span>{toast.text}</span>
            {toast.undo && (
              <button
                type="button"
                className="font-semibold text-sky-300 hover:text-sky-200"
                onClick={async () => { const u = toast.undo; setToast(null); await u?.() }}
              >
                {t('undo')}
              </button>
            )}
          </div>
        )}
      </div>
    </Ctx.Provider>
  )
}

export const useToast = () => useContext(Ctx)
