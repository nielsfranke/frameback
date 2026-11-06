/**
 * Frameback feature flags (environment variables, default off).
 * New behaviour ships dark and is switched on per instance:
 *   FEATURE_REVIEW_FLOW=true   clients may only approve versions sent "Zur Freigabe"
 *   FEATURE_NEW_SHARE=true     new client share page
 *   FEATURE_STUDIO_V2=true     new studio: sidebar with folders, project overview, project page, studio player
 */
const on = (name: string) => process.env[name] === 'true'

export const features = {
  get reviewFlow() { return on('FEATURE_REVIEW_FLOW') },
  get newShare() { return on('FEATURE_NEW_SHARE') },
  get studioV2() { return on('FEATURE_STUDIO_V2') },
}
