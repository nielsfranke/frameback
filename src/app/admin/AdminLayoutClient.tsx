'use client'

import { AuthProvider } from '@/components/AuthProvider'
import AdminSidebar from '@/components/AdminSidebar'
import SessionMonitor from '@/components/SessionMonitor'
import KofiWidget from '@/components/KofiWidget'
import { usePathname } from 'next/navigation'
import { useEffect } from 'react'
import { FeaturesProvider, type ClientFeatures } from '@/components/FeaturesProvider'
import { StudioDataProvider } from '@/components/studio/StudioData'
import { ToastProvider } from '@/components/studio/Toast'

export default function AdminLayoutClient({
  children,
  features,
}: {
  children: React.ReactNode
  features: ClientFeatures
}) {
  const pathname = usePathname()
  const hideNav = pathname?.match(/^\/admin\/projects\/[^/]+\/share/)

  // Prevent caching of admin pages
  useEffect(() => {
    // Set cache control headers via meta tags as fallback
    const metaCache = document.querySelector('meta[http-equiv="Cache-Control"]')
    if (!metaCache) {
      const meta = document.createElement('meta')
      meta.httpEquiv = 'Cache-Control'
      meta.content = 'no-store, no-cache, must-revalidate, private'
      document.head.appendChild(meta)

      const metaPragma = document.createElement('meta')
      metaPragma.httpEquiv = 'Pragma'
      metaPragma.content = 'no-cache'
      document.head.appendChild(metaPragma)

      const metaExpires = document.createElement('meta')
      metaExpires.httpEquiv = 'Expires'
      metaExpires.content = '0'
      document.head.appendChild(metaExpires)
    }
  }, [])

  return (
    <FeaturesProvider value={features}>
    <AuthProvider requireAuth={true}>
    <StudioDataProvider enabled={features.studioV2}>
    <ToastProvider>
      {/* Column on mobile (top bar above content), row on desktop (rail beside content). */}
      <div className="flex flex-1 min-h-0 flex-col overflow-x-hidden bg-background md:flex-row">
        {!hideNav && <AdminSidebar />}
        <div className="flex flex-1 min-w-0 min-h-0 flex-col">
          {children}
        </div>
        <SessionMonitor />
        <KofiWidget />
      </div>
    </ToastProvider>
    </StudioDataProvider>
    </AuthProvider>
    </FeaturesProvider>
  )
}
