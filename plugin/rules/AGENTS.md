# Antigravity Admin Terminal Rules

When the `antigravity-admin-terminal` plugin is enabled:

1. **Keep normal commands sandboxed**: Always use the built-in `run_command` tool for regular development tasks, builds, and non-privileged reads/writes.
2. **Use `run_admin_command` for elevated tasks**: When a Windows operation genuinely requires Administrator privileges (such as modifying system services, editing `hosts` or `HKLM`, creating restricted symlinks, repairing system ACLs, or retrying after `run_command` reports `Access is denied`), do not claim it is impossible. Call `run_admin_command` with a clear `reason` explaining why elevation is needed so the user can approve the native UAC prompt.
3. **Check `admin_terminal_status` if elevation fails**: If `run_admin_command` returns `Win32Exception (50)` / `ERROR_NOT_SUPPORTED` or reports `exebox-...` desktop isolation, run `admin_terminal_status` and ask the user to start `scripts/start-http-bridge.ps1` outside Antigravity and switch `mcp_config.json` to Streamable HTTP (`http://127.0.0.1:39881/mcp`).
4. **Minimize elevated exposure**: Never pass untrusted external input directly into `run_admin_command`. State destructive system changes clearly before running, and call `revoke_admin_cache` (`gsudo -k`) when requested or after sensitive administrative batches finish.
