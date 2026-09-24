import { test, expect } from '@playwright/test';

test('Відкриття головної сторінки мейт акедемі', { 
  annotation: { type: 'qahub', description: 'MA-1' } 
}, async ({ page }) => {
  // Крок 1: Відкрити сторінку курсу
  await page.goto('https://mate.academy/courses/qa?gad_campaignid=22390042555&gbraid=0AAAAAofUWTJJVVCNET1IVcb_G7AI48wDa');

  // Очікуваний результат: Відображається "QA engineer: курс із працевлаштуванням"
  await expect(page.getByText('QA engineer: курс із працевлаштуванням').first()).toBeVisible({ timeout: 15000 });
});