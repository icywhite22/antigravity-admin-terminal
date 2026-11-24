import crypto from 'node:crypto';
import http from 'node:http';
import readline from 'node:readline';
import {
  getAdminTerminalStatus,
  revokeAdminCache,
  runAdminCommand,
} from './gsudo.mjs';

const SERVER_INFO = {
  name: 'antigravity-admin-terminal',
  version: '0.1.0',
};

const TOOLS = [
  {
    name: 'admin_terminal_status',
    description:
      'Inspect whether this MCP server can trigger Windows UAC elevation via gsudo (checks WinSta/Desktop isolation, gsudo availability, and active credential cache state).',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'run_admin_command',
    description:
      'Execute a Windows terminal command with Administrator privileges via gsudo. Triggers a native Windows UAC prompt on first elevation and reuses the gsudo cache on this persistent MCP server PID.',
    inputSchema: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'The command or PowerShell script to execute as Administrator.',
        },
        reason: {
          type: 'string',
          description: 'Concise user-facing explanation of why Administrator privileges are required.',
        },
        cwd: {
          type: 'string',
          description: 'Optional local filesystem working directory (UNC paths are not supported by UAC elevation).',
        },
        shell: {
          type: 'string',
          enum: ['pwsh', 'powershell', 'cmd'],
          description: 'Shell to run inside elevated context. Defaults to pwsh.',
        },
        timeoutMs: {
          type: 'number',
          description: 'Timeout in milliseconds (1000 to 600000). Defaults to 120000 to allow time for UAC confirmation.',
        },
      },
      required: ['command', 'reason'],
    },
  },
  {
    name: 'revoke_admin_cache',
    description:
      'Immediately terminate all active gsudo elevated credential cache sessions (`gsudo -k`) so future elevated commands require a fresh UAC confirmation.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
];

function formatAdminCommandResult(result) {
  const lines = [
    `ok: ${result.ok}`,
    `exitCode: ${result.exitCode}`,
    `durationMs: ${result.durationMs}`,
    `cwd: ${result.cwd}`,
    `shell: ${result.shell}`,
  ];
  if (result.timedOut) {
    lines.push('timedOut: true');
  }
  if (result.hint) {
    lines.push(`hint: ${result.hint}`);
  }
  lines.push('--- stdout ---');
  lines.push(result.stdout ? result.stdout.trimEnd() : '(empty)');
  if (result.stdoutTruncated) {
    lines.push('[stdout truncated at 64 KB]');
  }
  if (result.stderr && result.stderr.trim()) {
    lines.push('--- stderr ---');
    lines.push(result.stderr.trimEnd());
    if (result.stderrTruncated) {
      lines.push('[stderr truncated at 64 KB]');
    }
  }
  return lines.join('\n');
}

async function handleToolCall(name, args, context) {
  try {
    if (name === 'admin_terminal_status') {
      const status = await getAdminTerminalStatus(context);
      return {
        content: [{ type: 'text', text: JSON.stringify(status, null, 2) }],
        isError: false,
      };
    }

    if (name === 'run_admin_command') {
      const result = await runAdminCommand(args || {});
      return {
        content: [{ type: 'text', text: formatAdminCommandResult(result) }],
        isError: !result.ok,
      };
    }

    if (name === 'revoke_admin_cache') {
      const result = await revokeAdminCache();
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        isError: false,
      };
    }

    return {
      content: [{ type: 'text', text: `Unknown tool: ${name}` }],
      isError: true,
    };
  } catch (error) {
    return {
      content: [{ type: 'text', text: error.message || String(error) }],
      isError: true,
    };
  }
}

function makeErrorResponse(id, code, message) {
  return {
    jsonrpc: '2.0',
    id: id ?? null,
    error: { code, message },
  };
}

export async function handleJsonRpcMessage(msg, context) {
  if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    return makeErrorResponse(msg?.id, -32600, 'Invalid JSON-RPC 2.0 request.');
  }

  const isNotification = msg.id === undefined || msg.id === null;

  if (msg.method === 'notifications/initialized' || msg.method === 'notifications/cancelled') {
    return null;
  }

  if (isNotification) {
    return null;
  }

  if (msg.method === 'initialize') {
    const requestedVersion =
      typeof msg.params?.protocolVersion === 'string'
        ? msg.params.protocolVersion
        : '2024-11-05';
    return {
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: requestedVersion,
        capabilities: {
          tools: { listChanged: false },
        },
        serverInfo: SERVER_INFO,
      },
    };
  }

  if (msg.method === 'ping') {
    return { jsonrpc: '2.0', id: msg.id, result: {} };
  }

  if (msg.method === 'tools/list') {
    return {
      jsonrpc: '2.0',
      id: msg.id,
      result: { tools: TOOLS },
    };
  }

  if (msg.method === 'tools/call') {
    const toolName = msg.params?.name;
    const toolArgs = msg.params?.arguments || {};
    if (typeof toolName !== 'string' || !toolName) {
      return makeErrorResponse(msg.id, -32602, 'Missing tool name.');
    }
    const result = await handleToolCall(toolName, toolArgs, context);
    return {
      jsonrpc: '2.0',
      id: msg.id,
      result,
    };
  }

  return makeErrorResponse(msg.id, -32601, `Method not found: ${msg.method}`);
}

function parseCliArgs(argv) {
  const opts = {
    transport: 'stdio',
    port: 39881,
    host: '127.0.0.1',
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--http') {
      opts.transport = 'http';
    } else if (arg === '--port' && argv[i + 1]) {
      const p = Number(argv[++i]);
      if (!Number.isInteger(p) || p < 0 || p > 65535) {
        throw new Error(`Invalid port: ${argv[i]}`);
      }
      opts.port = p;
    } else if (arg === '--host' && argv[i + 1]) {
      const h = argv[++i];
      if (h !== '127.0.0.1' && h !== 'localhost') {
        throw new Error(`Refusing non-loopback host "${h}" for security reasons.`);
      }
      opts.host = h;
    }
  }
  return opts;
}

export function startStdioServer(context = { transport: 'stdio', port: null }) {
  const rl = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });

  const pending = new Set();
  let writeChain = Promise.resolve();

  const sendLine = (obj) => {
    writeChain = writeChain.then(
      () =>
        new Promise((resolve) => {
          process.stdout.write(`${JSON.stringify(obj)}\n`, resolve);
        })
    );
    return writeChain;
  };

  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    const job = (async () => {
      let msg;
      try {
        msg = JSON.parse(trimmed);
      } catch {
        await sendLine(makeErrorResponse(null, -32700, 'Parse error'));
        return;
      }

      if (Array.isArray(msg)) {
        const replies = [];
        for (const item of msg) {
          const reply = await handleJsonRpcMessage(item, context);
          if (reply) replies.push(reply);
        }
        if (replies.length > 0) {
          await sendLine(replies);
        }
        return;
      }

      const reply = await handleJsonRpcMessage(msg, context);
      if (reply) {
        await sendLine(reply);
      }
    })();

    pending.add(job);
    job.finally(() => pending.delete(job));
  });

  rl.on('close', async () => {
    await Promise.allSettled([...pending]);
    await writeChain;
    process.exit(0);
  });
}

export function startHttpServer({ host = '127.0.0.1', port = 39881 } = {}) {
  const sessions = new Set();
  const MAX_BODY_BYTES = 1024 * 1024;
  let activePort = port;

  const isHostAllowed = (hostHeader) => {
    if (!hostHeader) return true;
    const lower = hostHeader.toLowerCase();
    return (
      lower === `127.0.0.1:${activePort}` ||
      lower === `localhost:${activePort}` ||
      lower === '127.0.0.1' ||
      lower === 'localhost'
    );
  };

  const server = http.createServer(async (req, res) => {
    // Reject browser-originated cross-origin / DNS-rebinding calls.
    if (req.headers.origin) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Origin header is forbidden for local admin MCP bridge.' }));
      return;
    }
    if (!isHostAllowed(req.headers.host)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid Host header.' }));
      return;
    }

    const url = new URL(req.url || '/', `http://127.0.0.1:${activePort}`);

    if (req.method === 'GET' && url.pathname === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, pid: process.pid, transport: 'http', port: activePort }));
      return;
    }

    if (url.pathname !== '/mcp') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
      return;
    }

    if (req.method === 'GET') {
      res.writeHead(405, { Allow: 'POST, DELETE', 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method Not Allowed. Use POST /mcp.' }));
      return;
    }

    if (req.method === 'DELETE') {
      const sid = req.headers['mcp-session-id'];
      if (typeof sid === 'string') {
        sessions.delete(sid);
      }
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method !== 'POST') {
      res.writeHead(405, { Allow: 'POST, DELETE' });
      res.end();
      return;
    }

    const chunks = [];
    let bodyBytes = 0;
    let aborted = false;

    req.on('data', (chunk) => {
      bodyBytes += chunk.length;
      if (bodyBytes > MAX_BODY_BYTES) {
        aborted = true;
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Payload too large' }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', async () => {
      if (aborted) return;

      let parsed;
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(makeErrorResponse(null, -32700, 'Parse error')));
        return;
      }

      const context = { transport: 'http', port: activePort };
      const headers = { 'Content-Type': 'application/json' };

      if (parsed?.method === 'initialize') {
        const sid = crypto.randomUUID();
        sessions.add(sid);
        headers['Mcp-Session-Id'] = sid;
      } else if (typeof req.headers['mcp-session-id'] === 'string') {
        headers['Mcp-Session-Id'] = req.headers['mcp-session-id'];
      }

      if (Array.isArray(parsed)) {
        const replies = [];
        for (const item of parsed) {
          const r = await handleJsonRpcMessage(item, context);
          if (r) replies.push(r);
        }
        if (replies.length === 0) {
          res.writeHead(202, headers);
          res.end();
          return;
        }
        res.writeHead(200, headers);
        res.end(JSON.stringify(replies));
        return;
      }

      const reply = await handleJsonRpcMessage(parsed, context);
      if (!reply) {
        res.writeHead(202, headers);
        res.end();
        return;
      }

      res.writeHead(200, headers);
      res.end(JSON.stringify(reply));
    });
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, host, () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') {
        activePort = addr.port;
      }
      console.error(
        `[antigravity-admin-terminal] Streamable HTTP MCP bridge listening at http://${host}:${activePort}/mcp (pid=${process.pid})`
      );
      resolve({ server, port: activePort, host });
    });
  });
}

const isMain =
  process.argv[1] &&
  import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());

if (isMain) {
  const opts = parseCliArgs(process.argv.slice(2));
  if (opts.transport === 'http') {
    startHttpServer({ host: opts.host, port: opts.port }).catch((err) => {
      console.error('[antigravity-admin-terminal] Failed to start HTTP bridge:', err);
      process.exit(1);
    });
  } else {
    startStdioServer({ transport: 'stdio', port: null });
  }
}
