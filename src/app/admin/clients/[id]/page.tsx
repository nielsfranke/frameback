'use client'

import { useEffect } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { useFeatures } from '@/components/FeaturesProvider'
import StudioClient from '@/components/studio/clients/StudioClient'

export default function ClientPage() {
  const { studioV2 } = useFeatures()
  const params = useParams()
  const router = useRouter()
  const id = params?.id as string
  // client pages only exist with the new studio
  useEffect(() => { if (!studioV2) router.replace('/admin/clients') }, [studioV2, router])
  if (!studioV2) return null
  return <StudioClient key={id} id={id} />
}
