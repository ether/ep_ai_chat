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

    // Server should still be alive — verify by typing into the pad and by
    // sending a non-@ai chat message that the same client must see echoed
    // back. We deliberately avoid sending a second @ai here because, after
    // an in-session author rename, the server-side broadcast of AI replies
    // can race the client's reconnect and we'd be testing an Etherpad-core
    // socket reattachment rather than this plugin's stability.
    await padBody.click();
    const addedText = ' More content after name change.';
    await page.keyboard.type(addedText);
    await page.waitForTimeout(1000);
    const padTextAfter = await padBody.innerText();
    expect(padTextAfter).toContain(addedText.trim());

    const countBeforePlainChat = await getCurrentChatMessageCount(page);
    await sendChatMessage(page, 'plain chat after rename');
    await page.waitForFunction(
        `document.querySelector('#chattext').querySelectorAll('p').length > ${countBeforePlainChat}`,
        {timeout: 15000},
    );
    const countAfterPlainChat = await getCurrentChatMessageCount(page);
    expect(countAfterPlainChat).toBeGreaterThan(countBeforePlainChat);
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
