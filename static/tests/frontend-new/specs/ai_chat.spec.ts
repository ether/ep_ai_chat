import {expect, test} from "@playwright/test";
import {
  goToNewPad,
  sendChatMessage,
  showChat,
  getCurrentChatMessageCount,
} from "../../../../../../etherpad-lite/src/tests/frontend-new/helper/padHelper";
import http from "http";

// Mock LLM server that responds to Anthropic API requests
let mockLLM: http.Server;
let mockPort: number;

test.beforeAll(async () => {
  await new Promise<void>((resolve) => {
    mockLLM = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk: string) => { body += chunk; });
      req.on('end', () => {
        res.writeHead(200, {'Content-Type': 'application/json'});
        // Respond in Anthropic format
        res.end(JSON.stringify({
          content: [{type: 'text', text: 'I can see this pad was written by you! The content appears to be a test message.'}],
          usage: {input_tokens: 100, output_tokens: 25},
        }));
      });
    });
    mockLLM.listen(0, () => {
      const addr = mockLLM.address();
      mockPort = typeof addr === 'object' && addr ? addr.port : 0;
      resolve();
    });
  });

  // Update Etherpad settings to use the mock LLM
  // We do this by hitting the admin API to update settings at runtime
  // For now, we rely on the settings.json being configured with the mock URL
  // The test assumes settings.json has ep_ai_core configured
});

test.afterAll(async () => {
  await new Promise<void>((resolve) => {
    if (mockLLM) mockLLM.close(() => resolve());
    else resolve();
  });
});

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

    // Wait for AI response (up to 15 seconds)
    await page.waitForFunction(
        `document.querySelector('#chattext').querySelectorAll('p').length >= 2`,
        {timeout: 15000},
    );

    // Verify AI responded
    const messageCount = await getCurrentChatMessageCount(page);
    expect(messageCount).toBeGreaterThanOrEqual(2);

    // Get the AI's response text
    const messages = page.locator('#chattext p');
    const lastMessage = messages.nth(messageCount - 1);
    const lastMessageText = await lastMessage.textContent();
    expect(lastMessageText).toBeTruthy();
    // AI response should be non-empty and not be our original message
    expect(lastMessageText).not.toContain('@ai who wrote this?');
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
