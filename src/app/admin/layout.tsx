import { features } from '@/lib/features'
import AdminLayoutClient from './AdminLayoutClient'

// Server wrapper: feature flags are runtime env vars, read here and handed down.
export const dynamic = 'force-dynamic'

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return <AdminLayoutClient features={{ studioV2: features.studioV2 }}>{children}</AdminLayoutClient>
}
