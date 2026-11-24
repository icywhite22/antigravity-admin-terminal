import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  encodePowerShellScript,
  getDesktopDiagnostics,
  resolvePowerShellExe,
} from './desktop-diag.mjs';

const execFileAsync = promisify(execFile);

const MAX_OUTPUT_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;

/**
 * Resolves the gsudo.exe executable path without relying on shell PATH refresh.
 */
export function resolveGsudoPath() {
  const candidates = [
    process.env.GSUDO_PATH,
    'C:\\Program Files\\gsudo\\Current\\gsudo.exe',
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  const pathDirs = (process.env.PATH || '').split(';').filter(Boolean);
  for (const dir of pathDirs) {
    const candidate = path.join(dir, 'gsudo.exe');
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

/**
 * Runs `gsudo status --json` and returns parsed state (omitting sensitive SIDs if desired).
 */
export async function getGsudoStatus(gsudoPath) {
  if (!gsudoPath) {
    return { installed: false, error: 'gsudo.exe not found' };
  }

  try {
    const { stdout } = await execFileAsync(gsudoPath, ['status', '--json'], {
      timeout: 10_000,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
    const parsed = JSON.parse(stdout.trim());
    return {
      installed: true,
      path: gsudoPath,
      callerPid: parsed.CallerPid,
      isElevated: parsed.IsElevated,
      isAdminMember: parsed.IsAdminMember,
      integrityLevel: parsed.IntegrityLevel,
      cacheMode: parsed.CacheMode,
      cacheAvailable: parsed.CacheAvailable,
      cacheSessionsCount: parsed.CacheSessionsCount,
      isRedirected: parsed.IsRedirected,
    };
  } catch (error) {
    return {
      installed: true,
      path: gsudoPath,
      error: error.message || String(error),
    };
  }
}

/**
 * Returns full diagnostic status for the MCP server, desktop isolation, and gsudo.
 */
export async function getAdminTerminalStatus({ transport, port }) {
  const gsudoPath = resolveGsudoPath();
  const [desktop, gsudo] = await Promise.all([
    getDesktopDiagnostics(),
    getGsudoStatus(gsudoPath),
  ]);

  const isExeboxIsolated =
    typeof desktop.desktop === 'string' && desktop.desktop.startsWith('exebox-');
  const isDefaultDesktop =
    desktop.winSta === 'WinSta0' && desktop.desktop === 'Default';

  let diagnosis;
  if (!gsudo.installed) {
    diagnosis =
      'gsudo.exe is not installed. Install it via `winget install gerardog.gsudo`.';
  } else if (desktop.isAdministrator === true) {
    diagnosis =
      'MCP server is already running elevated as Administrator; UAC prompts are not required.';
  } else if (isDefaultDesktop) {
    diagnosis =
      'Ready: MCP server is running on interactive desktop WinSta0\\Default. Calling run_admin_command will trigger UAC via gsudo and cache the session on this persistent MCP PID.';
  } else if (isExeboxIsolated) {
    diagnosis =
      `Blocked by desktop isolation (${desktop.winSta}\\${desktop.desktop}): Stdio MCP process was placed in an Antigravity exebox desktop, so Windows ShellExecuteEx("runas") will fail with Win32Exception (50). Switch plugin mcp_config.json to Streamable HTTP ("url": "http://127.0.0.1:${port || 39881}/mcp") and run scripts/start-http-bridge.ps1 in your normal user desktop.`;
  } else {
    diagnosis = `Unexpected desktop state (${desktop.winSta}\\${desktop.desktop}). Test with run_admin_command or switch to HTTP bridge if UAC fails.`;
  }

  return {
    serverPid: process.pid,
    nodeVersion: process.version,
    transport,
    httpPort: transport === 'http' ? port : null,
    desktop,
    gsudo,
    uacReady: Boolean(gsudo.installed && (isDefaultDesktop || desktop.isAdministrator)),
    diagnosis,
  };
}

/**
 * Validates and normalizes working directory for gsudo execution.
 * Rejects UNC paths because ShellExecuteEx fails with ERROR_NOT_SUPPORTED on UNC CWDs.
 */
export function validateWorkingDirectory(cwd) {
  const target = cwd ? path.resolve(cwd) : process.cwd();
  if (target.startsWith('\\\\')) {
    throw new Error(
      `UNC working directories (${target}) are not supported by Windows UAC elevation. Pass a local drive path such as C:\\ or E:\\...`
    );
  }
  if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
    throw new Error(`Working directory does not exist or is not a directory: ${target}`);
  }
  return target;
}

function appendBounded(state, chunk) {
  if (state.bytes >= MAX_OUTPUT_BYTES) {
    state.truncated = true;
    return;
  }
  const remaining = MAX_OUTPUT_BYTES - state.bytes;
  if (chunk.length <= remaining) {
    state.chunks.push(chunk);
    state.bytes += chunk.length;
  } else {
    state.chunks.push(chunk.subarray(0, remaining));
    state.bytes += remaining;
    state.truncated = true;
  }
}

/**
 * Executes a shell command with Administrator privileges via gsudo.exe.
 */
export async function runAdminCommand({
  command,
  cwd,
  reason,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  shell = 'pwsh',
}) {
  if (typeof command !== 'string' || !command.trim()) {
    throw new Error('`command` must be a non-empty string.');
  }
  if (typeof reason !== 'string' || !reason.trim()) {
    throw new Error('`reason` must be a non-empty explanation of why admin privileges are needed.');
  }

  const gsudoPath = resolveGsudoPath();
  if (!gsudoPath) {
    throw new Error('gsudo.exe was not found. Install it with `winget install gerardog.gsudo`.');
  }

  const resolvedCwd = validateWorkingDirectory(cwd);
  const clampedTimeout = Math.max(1_000, Math.min(Number(timeoutMs) || DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS));

  let args;
  let shellUsed;
  if (shell === 'cmd') {
    const cmdExe = process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe';
    shellUsed = cmdExe;
    args = ['--chdir', resolvedCwd, '-d', cmdExe, '/d', '/s', '/c', command];
  } else if (shell === 'powershell' || shell === 'pwsh') {
    const shellExe =
      shell === 'powershell'
        ? 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
        : resolvePowerShellExe();
    shellUsed = shellExe;
    const wrappedScript = [
      '[Console]::InputEncoding = [System.Text.Encoding]::UTF8',
      '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
      '$OutputEncoding = [System.Text.Encoding]::UTF8',
      command,
    ].join('\n');
    const encoded = encodePowerShellScript(wrappedScript);
    args = [
      '--chdir',
      resolvedCwd,
      '-d',
      shellExe,
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      encoded,
    ];
  } else {
    throw new Error(`Unsupported shell "${shell}". Expected "pwsh", "powershell", or "cmd".`);
  }

  console.error(
    `[antigravity-admin-terminal] audit time=${new Date().toISOString()} cwd=${JSON.stringify(resolvedCwd)} shell=${JSON.stringify(shell)} reason=${JSON.stringify(reason)}`
  );

  const startedAt = Date.now();
  return new Promise((resolve) => {
    const child = spawn(gsudoPath, args, {
      cwd: resolvedCwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    const outState = { chunks: [], bytes: 0, truncated: false };
    const errState = { chunks: [], bytes: 0, truncated: false };
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {
          stdio: 'ignore',
          windowsHide: true,
        });
      } catch {
        child.kill();
      }
    }, clampedTimeout);

    child.stdout.on('data', (chunk) => appendBounded(outState, chunk));
    child.stderr.on('data', (chunk) => appendBounded(errState, chunk));

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        ok: false,
        exitCode: null,
        timedOut,
        durationMs: Date.now() - startedAt,
        cwd: resolvedCwd,
        shell: shellUsed,
        stdout: Buffer.concat(outState.chunks).toString('utf8'),
        stderr: err.message || String(err),
        hint: 'Failed to launch gsudo.exe.',
      });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(outState.chunks).toString('utf8');
      const stderr = Buffer.concat(errState.chunks).toString('utf8');

      let hint = null;
      if (timedOut) {
        hint = `Command timed out after ${clampedTimeout}ms (possibly waiting for UAC confirmation).`;
      } else if (
        stderr.includes('Win32Exception (50)') ||
        stderr.includes('StartWithShellExecuteEx')
      ) {
        hint =
          'gsudo failed in ShellExecuteEx with ERROR_NOT_SUPPORTED (50). This usually means the MCP server itself is inside an isolated exebox desktop. Switch mcp_config.json to Streamable HTTP mode and run scripts/start-http-bridge.ps1 outside Antigravity.';
      } else if (code === 999 || stderr.includes('1223')) {
        hint = 'UAC elevation was cancelled by the user or failed.';
      }

      resolve({
        ok: !timedOut && code === 0,
        exitCode: code,
        timedOut,
        durationMs: Date.now() - startedAt,
        cwd: resolvedCwd,
        shell: shellUsed,
        stdout,
        stderr,
        stdoutTruncated: outState.truncated,
        stderrTruncated: errState.truncated,
        hint,
      });
    });
  });
}

/**
 * Kills all active gsudo credential cache sessions (`gsudo -k`).
 */
export async function revokeAdminCache() {
  const gsudoPath = resolveGsudoPath();
  if (!gsudoPath) {
    throw new Error('gsudo.exe was not found.');
  }
  const { stdout, stderr } = await execFileAsync(gsudoPath, ['-k'], {
    timeout: 10_000,
    windowsHide: true,
    maxBuffer: 256 * 1024,
  });
  return {
    ok: true,
    message: [stdout.trim(), stderr.trim()].filter(Boolean).join('\n') || 'All gsudo cached credentials invalidated.',
  };
}
