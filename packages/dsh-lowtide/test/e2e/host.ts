import type { Page } from '@playwright/test'

/** Prepare a fresh DSH home through first-run dialogs and workspace choice. */
export async function dismissHostDialogs(page: Page): Promise<void> {
  for (let i = 0; i < 8; i++) {
    const dialog = page.getByRole('dialog')
    const dismiss = dialog.getByRole('button', { name: /继续|Continue|关闭|Close|跳过|Skip|完成|Done/ }).first()
    if (await dismiss.count() === 0) break
    await dismiss.click()
    await page.waitForTimeout(250)
  }
  const choose = page.getByRole('button', { name: /^选择工作区$|^Choose workspace$/i })
  await Promise.race([
    page.locator('[data-slot="conversation.input.dock"]').waitFor({ state: 'visible', timeout: 10_000 }),
    choose.waitFor({ state: 'visible', timeout: 10_000 }),
  ]).catch(() => {})
  if (await choose.isVisible().catch(() => false)) {
    await choose.click()
    await page.locator('[role="menuitem"]:visible').first().click()
    await page.waitForTimeout(1000)
    await page.getByRole('button', { name: /新建会话|New session/i }).first().click()
    await page.locator('[data-slot="conversation.input.dock"]').waitFor({ state: 'visible', timeout: 10_000 })
  }
}
