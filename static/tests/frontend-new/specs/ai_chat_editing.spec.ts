import {expect, test} from "@playwright/test";
import {
  goToNewPad,
  getPadBody,
  sendChatMessage,
  showChat,
  getCurrentChatMessageCount,
} from "ep_etherpad-lite/tests/frontend-new/helper/padHelper";

test.beforeEach(async ({page, context}) => {
  await context.clearCookies();
});

test.describe('ep_ai_chat editing', () => {
  test('AI edit appears live in the pad without refresh', async ({page}) => {
    await goToNewPad(page);

    // Type identifiable content
    const padBody = await getPadBody(page);
    await padBody.click();
    await page.keyboard.type('the quick brown fox jumps over the lazy dog');
    await page.waitForTimeout(1000);

    // Get text before edit
    const textBefore = await padBody.innerText();
    expect(textBefore).toContain('the quick brown fox');

    // Ask AI to improve it
    await showChat(page);
    await sendChatMessage(page, '@ai improve this writing');

    // Wait for AI to respond (thinking + actual response)
    await page.waitForFunction(
        `document.querySelector('#chattext').querySelectorAll('p').length >= 3`,
        {timeout: 20000},
    );

    // Wait a bit more for the edit to be applied and broadcast
    await page.waitForTimeout(2000);

    // The pad content should have changed WITHOUT a refresh
    const textAfter = await padBody.innerText();
    expect(textAfter).not.toEqual(textBefore);
  });

  test('AI edited text shows with author color', async ({page}) => {
    await goToNewPad(page);

    const padBody = await getPadBody(page);
    await padBody.click();
    await page.keyboard.type('hello world this is a test');
    await page.waitForTimeout(1000);

    // Ask AI to edit
    await showChat(page);
    await sendChatMessage(page, '@ai make this more professional');

    // Wait for response and edit
    await page.waitForFunction(
        `document.querySelector('#chattext').querySelectorAll('p').length >= 3`,
        {timeout: 20000},
    );
    await page.waitForTimeout(2000);

    // Check that there are authored spans in the pad (colored text)
    // Etherpad wraps authored text in <span> elements with author classes
    const innerFrame = page.frame('ace_inner')!;
    const authorSpans = await innerFrame.locator('span[class*="author"]').count();
    expect(authorSpans).toBeGreaterThan(0);
  });

  test('AI appears in the confirmation chat message after editing', async ({page}) => {
    await goToNewPad(page);

    const padBody = await getPadBody(page);
    await padBody.click();
    await page.keyboard.type('a simple sentence that needs work');
    await page.waitForTimeout(1000);

    await showChat(page);
    await sendChatMessage(page, '@ai rewrite this to be better');

    // Wait for full response cycle
    await page.waitForFunction(
        `document.querySelector('#chattext').querySelectorAll('p').length >= 3`,
        {timeout: 20000},
    );

    // Check that one of the AI messages contains a success indicator or explanation
    const messageCount = await getCurrentChatMessageCount(page);
    const messages = page.locator('#chattext p');
    const allTexts: string[] = [];
    for (let i = 0; i < messageCount; i++) {
      allTexts.push(await messages.nth(i).textContent() || '');
    }

    // Should have: user message, thinking, and either a success message or explanation
    expect(allTexts.length).toBeGreaterThanOrEqual(3);
    // At least one message should be from the AI (not the user's message or thinking)
    const aiMessages = allTexts.filter((t) =>
        !t.includes('@ai') && !t.includes('Thinking'),
    );
    expect(aiMessages.length).toBeGreaterThan(0);
  });
});
