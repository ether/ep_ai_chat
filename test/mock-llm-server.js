'use strict';

const http = require('http');

const PORT = process.env.MOCK_LLM_PORT || 18089;

const isEditRequest = (messages) => {
  const userMsg = messages.filter((m) => m.role === 'user').pop();
  if (!userMsg) return false;
  return /\b(improve|edit|rewrite|fix|replace|change|make|better|concise|professional)\b/i.test(
      userMsg.content);
};

const getDocumentText = (messages) => {
  // The system messages contain the pad content. contextBuilder.js wraps
  // it in "--- BEGIN DOCUMENT (pad: ...) ---\n<text>\n--- END DOCUMENT ---".
  // We also fall back to the legacy "Current pad content:" header in case
  // older callers or tests are still around.
  for (const m of messages) {
    if (m.role === 'system' || m.role === undefined) {
      const content = typeof m === 'string' ? m : m.content;
      if (!content) continue;
      const newFmt = content.match(
          /--- BEGIN DOCUMENT[^-]*---\n([\s\S]*?)\n--- END DOCUMENT ---/);
      if (newFmt) return newFmt[1].trim();
      const oldFmt = content.match(
          /Current pad content[^:]*:\n\n([\s\S]*?)(\n\nAuthors:|$)/);
      if (oldFmt) return oldFmt[1].trim();
    }
  }
  return null;
};

const generateResponse = (messages, isAnthropic) => {
  const allMessages = isAnthropic
    ? [
      ...(messages.system ? [{role: 'system', content: messages.system}] : []),
      ...messages.messages,
    ]
    : messages.messages || messages;

  if (isEditRequest(allMessages)) {
    // Check if this is a JSON-only edit request (system prompt says "Output ONLY valid JSON")
    const systemContent =
        allMessages.filter((m) => m.role === 'system').map((m) => m.content).join(' ');
    if (systemContent.includes('Output ONLY valid JSON')) {
      const docText = getDocumentText(allMessages);
      if (docText) {
        const replacement = docText.charAt(0).toUpperCase() + docText.slice(1);
        return JSON.stringify({
          findText: docText,
          replaceText: `${replacement}. This text has been improved by AI.`,
        });
      }
    }
    // Normal edit response with JSON block
    const docText = getDocumentText(allMessages);
    const findText = docText || 'original text';
    const replaceText = `${findText.charAt(0).toUpperCase() + findText.slice(1)}. Improved by AI.`;
    return '```json\n' + JSON.stringify({
      action: 'edit',
      findText,
      replaceText,
      explanation: 'Improved the writing by capitalizing and expanding the text.',
    }, null, 2) + '\n```\n\nI\'ve improved the text by making it more polished and complete.';
  }

  return 'This pad was written by the test author. ' +
      'The content appears to be a test document with a single paragraph.';
};

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    try {
      const parsed = JSON.parse(body);
      const isAnthropic = req.headers['x-api-key'] !== undefined || req.url === '/messages';

      const responseText = generateResponse(parsed, isAnthropic);

      res.writeHead(200, {'Content-Type': 'application/json'});

      if (isAnthropic) {
        res.end(JSON.stringify({
          content: [{type: 'text', text: responseText}],
          usage: {input_tokens: 100, output_tokens: 50},
        }));
      } else {
        res.end(JSON.stringify({
          choices: [{message: {content: responseText}}],
          usage: {prompt_tokens: 100, completion_tokens: 50, total_tokens: 150},
        }));
      }
    } catch (err) {
      res.writeHead(400, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({error: {message: err.message}}));
    }
  });
});

server.listen(PORT, () => {
  console.log(`Mock LLM server listening on port ${PORT}`);
});

process.on('SIGTERM', () => { server.close(); process.exit(0); });
process.on('SIGINT', () => { server.close(); process.exit(0); });
