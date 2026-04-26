import { spawn } from 'child_process';
import iconv from 'iconv-lite';
import { Buffer } from 'buffer';

const SOFTWARE_COMMAND_CSV = `powershell -NoProfile -ExecutionPolicy Bypass -Command "$paths = @('HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*', 'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*', 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'); Get-ItemProperty $paths -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -and ($_.Publisher -notmatch 'Microsoft') -and ($_.DisplayName -notmatch '^Windows ') } | ForEach-Object { write-host \\"$($_.DisplayName)###$($_.DisplayVersion)###$($_.Publisher)\\" }"`;

/**
 * Isolated execution logic for Software Management
 */
async function softwareExec(host: string, command: string, user?: string, pass?: string): Promise<string> {
  const psexec = 'psexec.exe';
  const auth = [];
  if (user) auth.push('-u', user);
  if (pass) auth.push('-p', pass);

  const args = [`\\\\${host}`, ...auth, '-accepteula', '-nobanner', '-h', 'cmd', '/c', command];

  return new Promise((resolve, reject) => {
    const child = spawn(psexec, args, { shell: false, windowsHide: true });
    const stdoutChunks: Buffer[] = [];

    child.stdout.on('data', (d) => stdoutChunks.push(d));

    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Timeout na consulta de software'));
    }, 90000);

    child.on('close', () => {
      clearTimeout(timeout);
      const buf = Buffer.concat(stdoutChunks);
      let out = iconv.decode(buf, 'cp850');
      if (!out.trim() && buf.length > 0) out = iconv.decode(buf, 'utf-8');
      resolve(out.replace(/\0/g, ''));
    });

    child.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

/**
 * Parses the custom ### delimited format
 */
function parseSoftwareOutput(raw: string): any[] {
  const lines = raw.split(/\r?\n/);
  const apps: any[] = [];
  
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.includes('PsExec v') || trimmed.includes('starting') || trimmed.includes('exited')) continue;
    
    // Split by our custom delimiter
    const parts = trimmed.split('###');
    if (parts.length >= 1 && parts[0].trim()) {
      apps.push({
        Name: parts[0].trim(),
        Version: parts[1] ? parts[1].trim() : '---',
        Publisher: parts[2] ? parts[2].trim() : '---'
      });
    }
  }
  
  const unique = Array.from(new Map(apps.map(a => [a.Name, a])).values());
  return unique.sort((a, b) => a.Name.localeCompare(b.Name));
}

export async function getRemoteSoftware(host: string, user?: string, pass?: string): Promise<any[]> {
  try {
    console.log(`[SOFT_ISOLATED] Querying ${host} via CSV method`);
    const rawOutput = await softwareExec(host, SOFTWARE_COMMAND_CSV, user, pass);
    const apps = parseSoftwareOutput(rawOutput);
    console.log(`[SOFT_ISOLATED] Success. ${apps.length} apps found for ${host}`);
    return apps;
  } catch (err) {
    console.error(`[SOFT_ISOLATED_ERROR] ${host}:`, err);
    return [];
  }
}

export async function uninstallRemoteSoftware(host: string, appName: string, user?: string, pass?: string): Promise<boolean> {
  const uninstallCmd = `powershell -NoProfile -ExecutionPolicy Bypass -Command "$app = Get-ItemProperty @('HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*', 'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*', 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*') -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -eq '${appName}' } | Select-Object -First 1; if ($app.UninstallString) { $cmd = $app.UninstallString -replace 'msiexec.exe?\\s*/[iI]', 'msiexec.exe /x'; Start-Process cmd.exe -ArgumentList '/c', $cmd, '/quiet', '/norestart' -Wait }"`;

  try {
    console.log(`[SOFT_ISOLATED] Uninstalling "${appName}" on ${host}`);
    await softwareExec(host, uninstallCmd, user, pass);
    return true;
  } catch (err) {
    console.error(`[SOFT_ISOLATED_ERROR] ${host}:`, err);
    return false;
  }
}

