/**
 * Frameback product identity (visible name only – technical identifiers such as the npm
 * package, database and volumes keep "vitransfer"). Safe to import from client components.
 *
 * AGPL-3.0: Frameback is a modified version of ViTransfer. Users interacting with it over
 * the network must be offered the source: the share view links SOURCE_CODE_URL.
 */
export const APP_NAME = 'Frameback'
export const UPSTREAM_NAME = 'ViTransfer'
export const UPSTREAM_URL = 'https://github.com/MansiVisuals/ViTransfer'
export const SOURCE_CODE_URL = process.env.NEXT_PUBLIC_SOURCE_CODE_URL || 'https://github.com/nielsfranke/frameback'

/** Logo concept 1 ("Dialograhmen"): frame corners + speech bubble, inner 64×64 artwork. */
export const LOGO_CORNERS_PATH = 'M20 8H8V20M44 8H56V20M8 44V56H20M56 44V56H44'
export const LOGO_BUBBLE_PATH = 'M23 20H41Q46 20 46 25V35Q46 40 41 40H33L23 48V40Q18 40 18 35V25Q18 20 23 20Z'
