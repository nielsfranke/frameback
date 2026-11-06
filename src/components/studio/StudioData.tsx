'use client'

import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { apiFetch } from '@/lib/api-client'
import type { StudioFolder, StudioProject } from './views'

interface StudioData {
  enabled: boolean
  projects: StudioProject[]
  folders: StudioFolder[]
  loading: boolean
  error: boolean
  reload: () => Promise<void>
}

const Ctx = createContext<StudioData>({ enabled: false, projects: [], folders: [], loading: false, error: false, reload: async () => {} })

/** One shared load of the overview data for the sidebar counts and the project list. */
export function StudioDataProvider({ enabled, children }: { enabled: boolean; children: React.ReactNode }) {
  const [projects, setProjects] = useState<StudioProject[]>([])
  const [folders, setFolders] = useState<StudioFolder[]>([])
  const [loading, setLoading] = useState(enabled)
  const [error, setError] = useState(false)
  const inflight = useRef<Promise<void> | null>(null)

  const reload = useCallback(async () => {
    if (!enabled) return
    if (inflight.current) return inflight.current
    inflight.current = (async () => {
      try {
        const res = await apiFetch('/api/studio/projects', { cache: 'no-store' })
        if (!res.ok) throw new Error(String(res.status))
        const data = await res.json()
        setProjects(data.projects)
        setFolders(data.folders)
        setError(false)
      } catch {
        setError(true)
      } finally {
        setLoading(false)
        inflight.current = null
      }
    })()
    return inflight.current
  }, [enabled])

  useEffect(() => {
    if (!enabled) return
    void reload()
    // fresh counts when coming back to the tab (new feedback arrives in the background)
    const onFocus = () => { if (document.visibilityState === 'visible') void reload() }
    document.addEventListener('visibilitychange', onFocus)
    return () => document.removeEventListener('visibilitychange', onFocus)
  }, [enabled, reload])

  return <Ctx.Provider value={{ enabled, projects, folders, loading, error, reload }}>{children}</Ctx.Provider>
}

export const useStudioData = () => useContext(Ctx)
