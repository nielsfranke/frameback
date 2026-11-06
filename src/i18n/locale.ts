import { prisma } from '@/lib/db'

// Frameback: English and German only (Dutch removed; a stored 'nl' falls back to 'en')
export const SUPPORTED_LOCALES = ['en', 'de'] as const

export const LOCALE_NAMES: Record<string, string> = {
  en: 'English',
  de: 'Deutsch',
}

/**
 * Get the configured language from the database.
 * Falls back to 'en' if not set or on error.
 */
export async function getConfiguredLocale(): Promise<string> {
  try {
    const settings = await prisma.settings.findUnique({
      where: { id: 'default' },
      select: { language: true },
    })
    const lang = settings?.language
    return lang && (SUPPORTED_LOCALES as readonly string[]).includes(lang) ? lang : 'en'
  } catch {
    return 'en'
  }
}

/**
 * Load locale messages for server-side use (e.g., email templates).
 * Returns the full messages object for the given locale.
 */
export async function loadLocaleMessages(locale: string): Promise<Record<string, any>> {
  if (!(SUPPORTED_LOCALES as readonly string[]).includes(locale)) locale = 'en'
  try {
    return (await import(`../locales/${locale}.json`)).default
  } catch {
    return (await import('../locales/en.json')).default
  }
}

