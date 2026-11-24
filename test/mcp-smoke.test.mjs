import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import readline from 'node:readline';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { startHttpServer } from '../src/server.mjs';
import { validateWorkingDirectory } from '../src/gsudo.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const SERVER_PATH = path.resolve(__dirname, '../src/server.mjs');

function requestHttp(port, method, reqPath, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const payload = body !== undefined ? JSON.stringify(body) : null;
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path: reqPath,
        headers: {
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
          ...extraHeaders,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode, headers: res.headers, text });
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

test('Stdio MCP handshake and admin_terminal_status tool', async () => {
  const child = spawn(process.execPath, [SERVER_PATH], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  const rl = readline.createInterface({ input: child.stdout });
  const responses = [];
  let waiter = null;

  rl.on('line', (line) => {
    responses.push(JSON.parse(line));
    if (waiter) {
      const resolve = waiter;
      waiter = null;
      resolve();
    }
  });

  const nextResponse = () =>
    new Promise((resolve) => {
      if (responses.length > 0) {
        resolve(responses.shift());
      } else {
        waiter = () => resolve(responses.shift());
      }
    });

  child.stdin.write(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-03-26', clientInfo: { name: 'test', version: '1.0' } },
    }) + '\n'
  );
  const initResp = await nextResponse();
  assert.equal(initResp.id, 1);
  assert.equal(initResp.result.protocolVersion, '2025-03-26');
  assert.equal(initResp.result.serverInfo.name, 'antigravity-admin-terminal');

  // Notification should produce no reply
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');
  const listResp = await nextResponse();
  const names = listResp.result.tools.map((t) => t.name);
  assert.deepEqual(names, ['admin_terminal_status', 'run_admin_command', 'revoke_admin_cache']);

  child.stdin.write(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'admin_terminal_status', arguments: {} },
    }) + '\n'
  );
  const statusResp = await nextResponse();
  assert.equal(statusResp.result.isError, false);
  const parsed = JSON.parse(statusResp.result.content[0].text);
  assert.equal(parsed.transport, 'stdio');
  assert.equal(parsed.gsudo.installed, true);

  child.stdin.end();
  await new Promise((resolve) => child.on('close', resolve));
});

test('Streamable HTTP bridge security and MCP calls', async () => {
  const { server, port } = await startHttpServer({ host: '127.0.0.1', port: 0 });

  try {
    const health = await requestHttp(port, 'GET', '/healthz');
    assert.equal(health.status, 200);
    assert.equal(JSON.parse(health.text).ok, true);

    const forbiddenOrigin = await requestHttp(
      port,
      'POST',
      '/mcp',
      { jsonrpc: '2.0', id: 1, method: 'ping' },
      { Origin: 'https://evil.example' }
    );
    assert.equal(forbiddenOrigin.status, 403);

    const getMcp = await requestHttp(port, 'GET', '/mcp');
    assert.equal(getMcp.status, 405);

    const init = await requestHttp(port, 'POST', '/mcp', {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-03-26' },
    });
    assert.equal(init.status, 200);
    const sid = init.headers['mcp-session-id'];
    assert.ok(sid);

    const notif = await requestHttp(
      port,
      'POST',
      '/mcp',
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { 'Mcp-Session-Id': sid }
    );
    assert.equal(notif.status, 202);

    const list = await requestHttp(
      port,
      'POST',
      '/mcp',
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { 'Mcp-Session-Id': sid }
    );
    assert.equal(list.status, 200);
    assert.equal(JSON.parse(list.text).result.tools.length, 3);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('Validation guards reject UNC paths and invalid working directories', () => {
  assert.throws(() => validateWorkingDirectory('\\\\server\\share\\dir'), /UNC/);
  assert.throws(() => validateWorkingDirectory('Z:\\definitely-nonexistent-dir-12345'), /does not exist/);
});

test('Plugin manifests are valid and contain no local machine paths', () => {
  const pluginJson = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, 'plugin', 'plugin.json'), 'utf8')
  );
  const mcpConfig = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, 'plugin', 'mcp_config.json'), 'utf8')
  );

  assert.equal(pluginJson.name, 'antigravity-admin-terminal');
  assert.ok(mcpConfig.mcpServers?.admin);

  // Verify combined MCP tool names fit Antigravity's <= 64 character limit.
  const prefix = `mcp_${pluginJson.name}_admin_`;
  for (const toolName of ['admin_terminal_status', 'run_admin_command', 'revoke_admin_cache']) {
    assert.ok((prefix + toolName).length <= 64);
  }

  const serialized = JSON.stringify(mcpConfig);
  assert.equal(
    mcpConfig.mcpServers.admin.args[0],
    'C:/path/to/antigravity-admin-terminal/src/server.mjs'
  );
  assert.doesNotMatch(serialized, /C:\\Users\\/i);
});
