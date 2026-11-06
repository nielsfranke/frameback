import { expect, test } from '@playwright/test'

test('health endpoint answers', async ({ request }) => {
  const res = await request.get('/api/health')
  expect(res.status()).toBe(200)
})

test('admin login page renders', async ({ page }) => {
  await page.goto('/login')
  await expect(page.locator('#email')).toBeVisible()
  await expect(page.locator('#password')).toBeVisible()
})

test('open share link shows the project', async ({ page }) => {
  const slug = process.env.E2E_SHARE_SLUG
  test.skip(!slug, 'set E2E_SHARE_SLUG to a project with open access')
  await page.goto(`/share/${slug}`)
  // No password gate for open projects; the page shows at least one video or album.
  await expect(page.getByRole('heading').first()).toBeVisible()
  await expect(page.locator('video, img').first()).toBeVisible({ timeout: 20_000 })
})
