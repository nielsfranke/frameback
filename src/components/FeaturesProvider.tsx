'use client'

import { createContext, useContext } from 'react'

export interface ClientFeatures {
  studioV2: boolean
  reviewFlow: boolean
}

const Ctx = createContext<ClientFeatures>({ studioV2: false, reviewFlow: false })

export function FeaturesProvider({ value, children }: { value: ClientFeatures; children: React.ReactNode }) {
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export const useFeatures = () => useContext(Ctx)
