import {expect, test} from "@playwright/test";
import {
  goToNewPad,
  sendChatMessage,
  showChat,
  getCurrentChatMessageCount,
} from "ep_etherpad-lite/tests/frontend-new/helper/padHelper";

// The Etherpad instance under test is configured (via the workflow's
// generated settings.json) to point ep_ai_core at a sidecar mock LLM
// server. Tests don't need to set up their own mock here.

test.beforeEach(async ({page, context}) => {
  await context.clearCookies();
});

test.describe('ep_ai_chat', () => {
  test('AI responds to @ai mention in chat', async ({page}) => {
    await goToNewPad(page);

    // Type some content into the pad
    const padBody = page.frame('ace_inner')!.locator('#innerdocbody');
    await padBody.click();
    await page.keyboard.type('Hello, this is a test document written by me.');

    // Wait for content to sync
    await page.waitForTimeout(1000);

    // Open chat and send @ai message
    await showChat(page);
    await sendChatMessage(page, '@ai who wrote this?');

    // Our message should appear
    expect(await getCurrentChatMessageCount(page)).toBeGreaterThanOrEqual(1);

    // Wait for AI response — expecting at least 3 messages:
    // 1. Our @ai message, 2. "Thinking..." indicator, 3. Actual AI response
    await page.waitForFunction(
        `document.querySelector('#chattext').querySelectorAll('p').length >= 3`,
        {timeout: 15000},
    );

    // Verify AI responded with thinking indicator + actual response
    const messageCount = await getCurrentChatMessageCount(page);
    expect(messageCount).toBeGreaterThanOrEqual(3);

    // Check that a "Thinking..." message appeared
    const allMessages = page.locator('#chattext p');
    const allTexts: string[] = [];
    for (let i = 0; i < messageCount; i++) {
      allTexts.push(await allMessages.nth(i).textContent() || '');
    }
    expect(allTexts.some((t) => t.includes('Thinking'))).toBeTruthy();

    // The last message should be the actual AI response (not thinking, not our message)
    const lastMessageText = allTexts[allTexts.length - 1];
    expect(lastMessageText).not.toContain('@ai who wrote this?');
    expect(lastMessageText).not.toContain('Thinking');
  });

  test('AI does not respond to normal chat messages', async ({page}) => {
    await goToNewPad(page);

    await showChat(page);
    await sendChatMessage(page, 'just a normal message');

    // Wait a moment to ensure no AI response comes
    await page.waitForTimeout(3000);

    // Should only have our one message
    expect(await getCurrentChatMessageCount(page)).toBe(1);
  });
});
