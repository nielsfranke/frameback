/**
 * Frameback feature flags (environment variables, default off).
 * New behaviour ships dark and is switched on per instance:
 *   FEATURE_NEW_SHARE=true     new client share page
 *   FEATURE_STUDIO_V2=true     new studio: sidebar with folders, project overview, project page, studio player
 */
const on = (name: string) => process.env[name] === 'true'

export const features = {
  get newShare() { return on('FEATURE_NEW_SHARE') },
  get studioV2() { return on('FEATURE_STUDIO_V2') },
}
