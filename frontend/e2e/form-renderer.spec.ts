/**
 * Browser-level keyboard regression tests for A2UI form renderer.
 * Covers: modal background isolation (inert), Tab/Shift+Tab, Esc, focus
 * restore, collapsed-section error links, and Upload keyboard/announcement paths.
 */
import { expect, test } from '@playwright/test'

test.describe('Confirmation dialog modal isolation', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/e2e/fixtures/fixture.html?scenario=confirmation-dialog')
    await page.waitForSelector('form')
  })

  test('applies inert to background form when dialog opens and removes on close', async ({ page }) => {
    // Open the confirmation dialog
    await page.click('button:has-text("Reset")')
    const dialog = page.locator('[role="dialog"]')
    await expect(dialog).toBeVisible()

    // Background form should have inert
    const form = page.locator('form')
    await expect(form).toHaveAttribute('inert', '')

    // Cancel the dialog
    await page.click('[role="dialog"] button:has-text("Cancel")')
    await expect(dialog).not.toBeVisible()

    // inert should be removed
    await expect(form).not.toHaveAttribute('inert')
  })

  test('Tab and Shift+Tab cycle within dialog focusable elements', async ({ page }) => {
    await page.click('button:has-text("Reset")')
    const dialog = page.locator('[role="dialog"]')
    await expect(dialog).toBeVisible()

    // Initial focus on Confirm button
    const confirmButton = page.locator('[role="dialog"] button:has-text("Confirm")')
    await expect(confirmButton).toBeFocused()

    // Tab to Cancel
    await page.keyboard.press('Tab')
    const cancelButton = page.locator('[role="dialog"] button:has-text("Cancel")')
    await expect(cancelButton).toBeFocused()

    // Tab wraps back to Confirm
    await page.keyboard.press('Tab')
    await expect(confirmButton).toBeFocused()

    // Shift+Tab wraps to Cancel
    await page.keyboard.press('Shift+Tab')
    await expect(cancelButton).toBeFocused()
  })

  test('Escape cancels dialog and restores focus to trigger button', async ({ page }) => {
    const resetButton = page.locator('button:has-text("Reset")')
    await resetButton.focus()
    await resetButton.click()

    const dialog = page.locator('[role="dialog"]')
    await expect(dialog).toBeVisible()

    // Press Escape
    await page.keyboard.press('Escape')
    await expect(dialog).not.toBeVisible()

    // Focus restored to trigger button
    await expect(resetButton).toBeFocused()
  })

  test('Escape cancels dialog even when focus is on a background element (global listener)', async ({ page }) => {
    await page.click('button:has-text("Reset")')
    const dialog = page.locator('[role="dialog"]')
    await expect(dialog).toBeVisible()

    // Move focus outside the dialog (focusIn trap will pull it back, but we
    // programmatically place it on body to verify global Escape still fires).
    await page.evaluate(() => {
      // The form is inert → its children can't be focused. Focus body instead.
      (document.activeElement as HTMLElement)?.blur()
    })
    // Verify dialog is still visible despite focus change.
    await expect(dialog).toBeVisible()

    // Global Escape listener on document should still cancel.
    await page.keyboard.press('Escape')
    await expect(dialog).not.toBeVisible()
  })

  test('Confirm closes dialog and restores focus to trigger button', async ({ page }) => {
    const resetButton = page.locator('button:has-text("Reset")')
    await resetButton.click()

    const dialog = page.locator('[role="dialog"]')
    await expect(dialog).toBeVisible()

    await page.click('[role="dialog"] button:has-text("Confirm")')
    await expect(dialog).not.toBeVisible()
    await expect(resetButton).toBeFocused()
  })
})

test.describe('Collapsed section error links', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/e2e/fixtures/fixture.html?scenario=collapsed-section')
    await page.waitForSelector('form')
  })

  test('expands collapsed ancestor section and focuses field on error link click', async ({ page }) => {
    // Submit the form to trigger validation errors
    await page.click('button:has-text("Submit")')

    // Error summary should appear
    const errorLink = page.locator('[role="alert"] a')
    await expect(errorLink).toBeVisible()

    // Click the error link
    await errorLink.click()

    // The collapsed section should expand
    const sectionToggle = page.locator('button:has-text("Billing")')
    await expect(sectionToggle).toHaveAttribute('aria-expanded', 'true')

    // The field should receive focus
    const amountField = page.getByLabel(/Amount/)
    await expect(amountField).toBeFocused()
  })

  test('error link href does not contain percent-encoded characters for colon IDs', async ({ page }) => {
    await page.click('button:has-text("Submit")')
    const errorLink = page.locator('[role="alert"] a')
    await expect(errorLink).toBeVisible()

    const href = await errorLink.getAttribute('href')
    expect(href).not.toContain('%')
  })
})

test.describe('Upload keyboard and announcement paths', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/e2e/fixtures/fixture.html?scenario=upload')
    await page.waitForSelector('form')
  })

  test('choose-file button is keyboard-triggerable via Enter', async ({ page }) => {
    const chooseFile = page.locator('button:has-text("Choose file")')

    // Set up the filechooser listener BEFORE triggering the keyboard action.
    // Use locator-level press() so the event targets the button directly.
    const fileChooserPromise = page.waitForEvent('filechooser')
    await chooseFile.press('Enter')

    // Must receive the filechooser event — proves Enter triggered the hidden input's click.
    const fileChooser = await fileChooserPromise
    await fileChooser.setFiles({
      name: 'kb-trigger.png',
      mimeType: 'image/png',
      buffer: Buffer.from('kb-test'),
    })

    // File should appear in the upload list.
    await expect(page.getByRole('listitem').filter({ hasText: 'kb-trigger.png' })).toBeVisible()
  })

  test('upload progress is surfaced in an aria-live region', async ({ page }) => {
    // Simulate file selection
    const fileChooserPromise = page.waitForEvent('filechooser')
    await page.click('button:has-text("Choose file")')
    const fileChooser = await fileChooserPromise
    await fileChooser.setFiles({
      name: 'test.png',
      mimeType: 'image/png',
      buffer: Buffer.from('test-image-content'),
    })

    // Report progress via the exposed bridge
    await page.evaluate(() => {
      window.__e2e.uploadProgress?.(60)
    })

    // The aria-live region should report the progress
    const liveRegion = page.locator('[role="status"][aria-live="polite"]')
    await expect(liveRegion).toContainText('60% uploaded')

    // Complete the upload
    await page.evaluate(() => {
      window.__e2e.uploadResolve?.({ fileId: 'e2e-file-1', name: 'test.png', size: 18, mimeType: 'image/png' })
    })

    // Uploaded file should appear in the list
    await expect(page.locator('text=test.png')).toBeVisible()
    // The aria-live progress should clear
    await expect(liveRegion).not.toContainText('% uploaded')
  })

  test('failed upload can be removed via Remove button', async ({ page }) => {
    // Simulate file selection that will fail
    const fileChooserPromise = page.waitForEvent('filechooser')
    await page.click('button:has-text("Choose file")')
    const fileChooser = await fileChooserPromise
    await fileChooser.setFiles({
      name: 'fail.png',
      mimeType: 'image/png',
      buffer: Buffer.from('fail-content'),
    })

    // Reject the upload
    await page.evaluate(() => {
      window.__e2e.uploadReject?.(new Error('Upload failed'))
    })

    // Should show Remove button for failed upload
    const removeButton = page.locator('button:has-text("Remove fail.png")')
    await expect(removeButton).toBeVisible()

    // The live region should announce the failure.
    const liveRegion = page.locator('[role="status"][aria-live="polite"]')
    await expect(liveRegion).toContainText('fail.png')
    await expect(liveRegion).toContainText('Upload failed')

    // Click Remove
    await removeButton.click()

    // Failed item should disappear
    await expect(removeButton).not.toBeVisible()
  })

  test('failed upload can be retried via Retry button', async ({ page }) => {
    // First attempt fails
    const fileChooserPromise1 = page.waitForEvent('filechooser')
    await page.click('button:has-text("Choose file")')
    const fileChooser1 = await fileChooserPromise1
    await fileChooser1.setFiles({
      name: 'retry.png',
      mimeType: 'image/png',
      buffer: Buffer.from('retry-content'),
    })

    await page.evaluate(() => {
      window.__e2e.uploadReject?.(new Error('offline'))
    })

    const retryButton = page.locator('button:has-text("Retry retry.png")')
    await expect(retryButton).toBeVisible()

    // Set up success for the retry attempt
    await page.evaluate(() => {
      // Reset the upload bridge to succeed on next call
      window.__e2e.uploadResolve = (result) => {
        // The bridge creates a new promise each time, so we need a different approach.
        // Let the retry click happen and immediately resolve.
      }
    })

    // Click retry - the upload bridge will fire again
    // Since the bridge creates a new Promise each call, we need to resolve it after clicking
    await retryButton.click()

    // Immediately resolve
    await page.evaluate(() => {
      window.__e2e.uploadResolve?.({ fileId: 'e2e-retry-1', name: 'retry.png', size: 13, mimeType: 'image/png' })
    })

    // Should show uploaded file
    await expect(page.locator('text=retry.png')).toBeVisible()
    await expect(retryButton).not.toBeVisible()
  })
})

test.describe('submitOnEnter keyboard behavior', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/e2e/fixtures/fixture.html?scenario=submit-on-enter')
    await page.waitForSelector('form')
  })

  test('Enter in editable single-line text input triggers submit', async ({ page }) => {
    const nameField = page.getByLabel(/Name/)
    await nameField.focus()
    await nameField.fill('Ada')

    // Submission is kept pending so aria-busy=true is observable.
    const submitButton = page.locator('button:has-text("Submit")')
    await page.keyboard.press('Enter')

    // Must transition to aria-busy=true during the pending submission.
    await expect(submitButton).toHaveAttribute('aria-busy', 'true')

    // Verify the submit function was called exactly once.
    const callCount = await page.evaluate(() => window.__e2e.submitCallCount)
    expect(callCount).toBe(1)

    // Resolve the pending submission so the test can clean up.
    await page.evaluate(() => window.__e2e.resolveSubmit())
    await expect(submitButton).toHaveAttribute('aria-busy', 'false')
  })

  test('Enter in TextArea does NOT trigger submit', async ({ page }) => {
    const notesField = page.getByLabel(/Notes/)
    await notesField.focus()
    await notesField.fill('Some notes')
    await page.keyboard.press('Enter')

    // TextArea should still have focus (Enter just adds a newline).
    await expect(notesField).toBeFocused()
    // Submit must NOT have been called.
    const callCount = await page.evaluate(() => window.__e2e.submitCallCount)
    expect(callCount).toBe(0)
  })

  test('Enter in Select does NOT trigger submit', async ({ page }) => {
    const planSelect = page.getByLabel(/Plan/)
    await planSelect.focus()
    await page.keyboard.press('Enter')

    // Select should still have focus.
    await expect(planSelect).toBeFocused()
    // Submit must NOT have been called.
    const callCount = await page.evaluate(() => window.__e2e.submitCallCount)
    expect(callCount).toBe(0)
  })
})
