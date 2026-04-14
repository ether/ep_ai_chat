'use strict';

const http = require('http');
const assert = require('assert');
const {spawn} = require('child_process');

describe('mock-llm-server', function () {
  let serverProcess;
  const PORT = 18099; // Use a different port for testing the mock itself

  before(function (done) {
    serverProcess = spawn('node', ['test/mock-llm-server.js'], {
      cwd: `${__dirname}/..`,
      env: {...process.env, MOCK_LLM_PORT: PORT},
    });
    // Wait for server to start
    setTimeout(done, 1500);
  });

  after(function () {
    if (serverProcess) serverProcess.kill();
  });

  it('responds to Anthropic format requests', function (done) {
    const body = JSON.stringify({
      system: 'You are helpful',
      messages: [{role: 'user', content: 'who wrote this?'}],
    });
    const req = http.request({
      hostname: '127.0.0.1',
      port: PORT,
      path: '/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': 'test',
        'anthropic-version': '2023-06-01',
      },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        const parsed = JSON.parse(data);
        assert.ok(parsed.content);
        assert.ok(parsed.content[0].text);
        assert.ok(parsed.usage);
        done();
      });
    });
    req.write(body);
    req.end();
  });

  it('responds to OpenAI format requests', function (done) {
    const body = JSON.stringify({
      model: 'test',
      messages: [{role: 'user', content: 'hello'}],
    });
    const req = http.request({
      hostname: '127.0.0.1',
      port: PORT,
      path: '/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer test-key',
      },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        const parsed = JSON.parse(data);
        assert.ok(parsed.choices);
        assert.ok(parsed.choices[0].message.content);
        done();
      });
    });
    req.write(body);
    req.end();
  });

  it('returns edit JSON for edit requests', function (done) {
    const body = JSON.stringify({
      system: 'Current pad content:\n\nhello world',
      messages: [{role: 'user', content: 'improve this'}],
    });
    const req = http.request({
      hostname: '127.0.0.1',
      port: PORT,
      path: '/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': 'test',
        'anthropic-version': '2023-06-01',
      },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        const parsed = JSON.parse(data);
        const text = parsed.content[0].text;
        assert.ok(
            text.includes('```json') || text.includes('findText'),
            'Should contain edit JSON');
        done();
      });
    });
    req.write(body);
    req.end();
  });
});
