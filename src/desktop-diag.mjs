import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const DIAG_SCRIPT = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;

public class AgyDesktopDiag {
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] public static extern IntPtr GetThreadDesktop(uint dwThreadId);
    [DllImport("user32.dll")] public static extern IntPtr GetProcessWindowStation();
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern bool GetUserObjectInformationW(IntPtr hObj, int nIndex, StringBuilder pvInfo, int nLength, out int lpnLengthNeeded);
    [DllImport("kernel32.dll")] public static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll")] public static extern bool IsProcessInJob(IntPtr ProcessHandle, IntPtr JobHandle, out bool Result);

    public static string GetObjName(IntPtr h) {
        var sb = new StringBuilder(256);
        int needed;
        if (GetUserObjectInformationW(h, 2, sb, sb.Capacity * 2, out needed)) return sb.ToString();
        return "err:" + Marshal.GetLastWin32Error();
    }
}
"@

$principal = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
$isAdmin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$winsta = [AgyDesktopDiag]::GetObjName([AgyDesktopDiag]::GetProcessWindowStation())
$desktop = [AgyDesktopDiag]::GetObjName([AgyDesktopDiag]::GetThreadDesktop([AgyDesktopDiag]::GetCurrentThreadId()))
$inJob = $false
[void][AgyDesktopDiag]::IsProcessInJob([AgyDesktopDiag]::GetCurrentProcess(), [IntPtr]::Zero, [ref]$inJob)

[PSCustomObject]@{
    isAdministrator = $isAdmin
    winSta          = $winsta
    desktop         = $desktop
    inJob           = $inJob
    sessionId       = [System.Diagnostics.Process]::GetCurrentProcess().SessionId
    userInteractive = [Environment]::UserInteractive
} | ConvertTo-Json -Compress
`;

/**
 * Resolves the preferred PowerShell executable on Windows.
 * Prefers PowerShell 7 (pwsh.exe) and falls back to Windows PowerShell 5.1.
 */
export function resolvePowerShellExe() {
  const candidates = [
    process.env.AGY_ADMIN_PWSH,
    path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'PowerShell', '7', 'pwsh.exe'),
    'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  const pathDirs = (process.env.PATH || '').split(';').filter(Boolean);
  for (const dir of pathDirs) {
    const candidate = path.join(dir, 'pwsh.exe');
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
}

/**
 * Encodes a PowerShell script as UTF-16LE Base64 for -EncodedCommand.
 */
export function encodePowerShellScript(script) {
  return Buffer.from(script, 'utf16le').toString('base64');
}

/**
 * Inspects the current MCP server process's Windows desktop, window station,
 * job-object status, and administrator role.
 */
export async function getDesktopDiagnostics() {
  const shellExe = resolvePowerShellExe();
  const encoded = encodePowerShellScript(DIAG_SCRIPT);

  try {
    const { stdout } = await execFileAsync(
      shellExe,
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      { timeout: 15000, windowsHide: true, maxBuffer: 1024 * 1024 }
    );
    return JSON.parse(stdout.trim());
  } catch (error) {
    return {
      error: error.message || String(error),
      winSta: 'unknown',
      desktop: 'unknown',
      inJob: null,
      isAdministrator: null,
    };
  }
}
