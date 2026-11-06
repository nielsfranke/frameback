'use client'

import { Suspense, useEffect } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { useFeatures } from '@/components/FeaturesProvider'
import StudioReview from '@/components/studio/review/StudioReview'

export default function StudioReviewPage() {
  const { studioV2 } = useFeatures()
  const params = useParams()
  const router = useRouter()
  const id = params?.id as string
  // the studio player only exists with the new studio; otherwise back to the project
  useEffect(() => { if (!studioV2) router.replace(`/admin/projects/${id}`) }, [studioV2, id, router])
  if (!studioV2) return null
  return <Suspense fallback={null}><StudioReview key={id} projectId={id} /></Suspense>
}
