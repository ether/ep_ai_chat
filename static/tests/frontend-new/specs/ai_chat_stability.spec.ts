import {expect, test} from "@playwright/test";
import {
  goToNewPad,
  sendChatMessage,
  showChat,
  toggleUserList,
  setUserName,
  getCurrentChatMessageCount,
} from "ep_etherpad-lite/tests/frontend-new/helper/padHelper";

test.beforeEach(async ({page, context}) => {
  await context.clearCookies();
});

test.describe('ep_ai_chat stability', () => {
  test('server survives author name change after @ai message', async ({page}) => {
    await goToNewPad(page);

    // Type some content
    const padBody = page.frame('ace_inner')!.locator('#innerdocbody');
    await padBody.click();
    await page.keyboard.type('Test content for stability check.');
    await page.waitForTimeout(1000);

    // Send @ai message
    await showChat(page);
    await sendChatMessage(page, '@ai summarize this');

    // Wait for AI response
    await page.waitForFunction(
        `document.querySelector('#chattext').querySelectorAll('p').length >= 2`,
        {timeout: 15000},
    );

    // Now change author name — this was causing crashes
    await toggleUserList(page);
    await setUserName(page, 'TestUser');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(2000);

    // Server should still be alive — verify by typing more content
    await padBody.click();
    await page.keyboard.type(' More content after name change.');
    await page.waitForTimeout(1000);

    // Send another @ai message — server should still respond
    await sendChatMessage(page, '@ai are you still there?');

    // Wait for second AI response
    const countBefore = await getCurrentChatMessageCount(page);
    await page.waitForFunction(
        `document.querySelector('#chattext').querySelectorAll('p').length > ${countBefore}`,
        {timeout: 15000},
    );

    // Verify we got more messages (server didn't crash)
    const countAfter = await getCurrentChatMessageCount(page);
    expect(countAfter).toBeGreaterThan(countBefore);
  });

  test('server survives rapid chat messages', async ({page}) => {
    await goToNewPad(page);

    await showChat(page);

    // Send several messages quickly
    await sendChatMessage(page, 'message 1');
    await sendChatMessage(page, 'message 2');
    await sendChatMessage(page, '@ai hello');
    await sendChatMessage(page, 'message 3');

    // Wait for AI to respond
    await page.waitForFunction(
        `document.querySelector('#chattext').querySelectorAll('p').length >= 5`,
        {timeout: 15000},
    );

    // Server should still be responding
    const count = await getCurrentChatMessageCount(page);
    expect(count).toBeGreaterThanOrEqual(5);
  });
});
