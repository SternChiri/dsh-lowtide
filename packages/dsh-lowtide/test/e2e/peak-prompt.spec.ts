import { test, expect } from '@playwright/test'
import { dismissHostDialogs } from './host.ts'

const PROMPT = '[data-lowtide-peak-prompt]'

test('peak prompt keeps the native composer resident through typing, IME composition and queueing', async ({ page, request }) => {
  test.setTimeout(120_000)
  const original = await (await request.get('/ds-lowtide/config')).json()
  let createdTaskId: string | undefined
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(String(error)))

  await request.put('/ds-lowtide/config', {
    data: {
      windows: [{
        id: 'e2e-priced', level: 'custom', start: '00:00', end: '23:59',
        days: [1, 2, 3, 4, 5, 6, 7], multiplier: 2,
      }],
    },
  })

  try {
    await page.goto(process.env.DSH_E2E_URL ?? '/')
    await page.waitForTimeout(1500)
    await dismissHostDialogs(page)
    await expect(page.locator('[data-slot="conversation.input.dock"]')).toBeVisible()
    const composer = page.locator('[contenteditable="true"]:visible').first()
    await expect(composer).toBeVisible()
    await composer.evaluate((element) => { element.setAttribute('data-lowtide-test-composer', '') })
    await composer.fill('')
    await expect(page.locator(PROMPT)).toHaveCount(0)

    await composer.focus()
    await composer.pressSequentially('abc')
    await expect(page.locator(PROMPT)).toBeVisible()
    await expect(composer).toBeFocused()
    await expect(composer).toHaveText('abc')
    await expect(composer).toHaveAttribute('data-lowtide-test-composer', '')
    await expect(page.locator(`${PROMPT} textarea`)).toHaveCount(0)

    await composer.evaluate((element) => {
      element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
      element.dispatchEvent(new CompositionEvent('compositionupdate', { bubbles: true, data: 'ni' }))
    })
    await page.keyboard.insertText('ni')
    await expect(composer).toBeFocused()
    await composer.evaluate((element) => {
      element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: 'ni' }))
    })
    await expect(composer).toHaveText('abcni')
    await expect(composer).toBeFocused()
    await expect(page.locator(PROMPT)).toBeVisible()

    await dismissHostDialogs(page)
    await page.route('**/ds-lowtide/tasks', async (route) => {
      if (route.request().method() !== 'POST') return route.fallback()
      await route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'e2e rejection' }) })
    })
    const failed = page.waitForResponse((response) => response.url().endsWith('/ds-lowtide/tasks') && response.request().method() === 'POST')
    await page.getByRole('button', { name: /投递到闲时队列|Queue for off-peak/ }).click()
    await failed
    await expect(composer).toHaveText('abcni')
    await expect(page.locator(PROMPT)).toBeVisible()
    await page.unroute('**/ds-lowtide/tasks')

    await dismissHostDialogs(page)
    await page.locator(`${PROMPT} button[title]`).click()
    await expect(page.locator(PROMPT)).toHaveCount(0)
    await expect(composer).toHaveText('abcni')
    await composer.fill('')
    await composer.pressSequentially('retry')
    await expect(page.locator(PROMPT)).toBeVisible()

    await dismissHostDialogs(page)
    const succeeded = page.waitForResponse((response) => response.url().endsWith('/ds-lowtide/tasks') && response.request().method() === 'POST')
    await page.getByRole('button', { name: /投递到闲时队列|Queue for off-peak/ }).click()
    const response = await succeeded
    const payload = await response.json()
    expect(payload.ok).toBe(true)
    expect(payload.task.prompt).toBe('retry')
    createdTaskId = payload.task.id
    await expect(composer).toHaveText('')
    await expect(page.locator(PROMPT)).toHaveCount(0)
    expect(errors).toEqual([])
  } finally {
    await page.unroute('**/ds-lowtide/tasks').catch(() => {})
    if (createdTaskId !== undefined) await request.post(`/ds-lowtide/tasks/${createdTaskId}/delete`).catch(() => {})
    await request.put('/ds-lowtide/config', { data: { windows: original.config.windows } }).catch(() => {})
  }
})
