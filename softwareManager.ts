import { spawn } from 'child_process';
import iconv from 'iconv-lite';
import { Buffer } from 'buffer';

const SOFTWARE_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
$paths = @(
    'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
    'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
    'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'
)
foreach ($path in $paths) {
    $items = Get-ItemProperty $path
    foreach ($item in $items) {
        if ($item.DisplayName) {
            $name = $item.DisplayName
            $ver = if ($item.DisplayVersion) { $item.DisplayVersion } else { "---" }
            $pub = if ($item.Publisher) { $item.Publisher } else { "---" }
            # Filter Microsoft-labeled apps to reduce clutter as requested before
            if ($pub -notmatch "Microsoft" -and $name -notmatch "^Windows") {
                Write-Output "$name###$ver###$pub"
            }
        }
    }
}
`;

/**
 * Isolated execution logic for Software Management
 */
async function softwareExec(host: string, script: string, user?: string, pass?: string): Promise<string> {
  const psexec = 'psexec.exe';
  const auth = [];
  if (user) auth.push('-u', user);
  if (pass) auth.push('-p', pass);

  // Use EncodedCommand to avoid escaping nightmares
  const encodedScript = Buffer.from(script, 'utf16le').toString('base64');
  const args = [`\\\\${host}`, ...auth, '-accepteula', '-nobanner', '-h', 'powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodedScript];

  return new Promise((resolve, reject) => {
    const child = spawn(psexec, args, { shell: false, windowsHide: true });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout.on('data', (d) => stdoutChunks.push(d));
    child.stderr.on('data', (d) => stderrChunks.push(d));

    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Timeout na consulta de software'));
    }, 90000);

    child.on('close', (code) => {
      clearTimeout(timeout);
      const buf = Buffer.concat(stdoutChunks);
      let out = iconv.decode(buf, 'cp850');
      if (!out.trim() && buf.length > 0) out = iconv.decode(buf, 'utf-8');
      
      const errBuf = Buffer.concat(stderrChunks);
      const errOut = iconv.decode(errBuf, 'cp850');
      if (errOut.trim()) {
        console.warn(`[SOFT_EXEC_WARN] Stderr for ${host}:`, errOut);
      }

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
    console.log(`[SOFT_ISOLATED] Querying ${host} via PowerShell EncodedCommand`);
    const rawOutput = await softwareExec(host, SOFTWARE_SCRIPT, user, pass);
    const apps = parseSoftwareOutput(rawOutput);
    console.log(`[SOFT_ISOLATED] Success. ${apps.length} apps found for ${host}`);
    return apps;
  } catch (err) {
    console.error(`[SOFT_ISOLATED_ERROR] ${host}:`, err);
    return [];
  }
}

export async function uninstallRemoteSoftware(host: string, appName: string, user?: string, pass?: string): Promise<boolean> {
  const uninstallScript = `
$appName = "${appName}"

$paths = @(
 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
 'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'
)

$app = Get-ItemProperty $paths -ErrorAction SilentlyContinue |
Where-Object { $_.DisplayName -like "*$appName*" } |
Select-Object -First 1

if (-not $app) {
    Write-Error "Aplicativo não encontrado"
    exit 1
}

Write-Host "Encontrado: $($app.DisplayName)"

$cmd = $app.QuietUninstallString
if (-not $cmd) { $cmd = $app.UninstallString }

if (-not $cmd) {
    Write-Error "Sem comando de desinstalação"
    exit 1
}

Write-Host "Comando: $cmd"

# --- MSI ---
if ($cmd -match "msiexec") {
    if ($cmd -match "{[A-Z0-9-]+}") {
        $guid = $matches[0]
        Write-Host "MSI GUID: $guid"
        Start-Process "msiexec.exe" -ArgumentList "/x $guid /quiet /norestart" -Wait
    } else {
        Write-Host "Executando MSI direto"
        Start-Process "cmd.exe" -ArgumentList "/c $cmd /quiet /norestart" -Wait
    }
}
else {
    # --- EXE ROBUSTO ---
    $cmd = $cmd.Trim()
    $exe = ""
    $args = ""

    if ($cmd -match '^"([^"]+)"\s*(.*)$') {
        $exe = $Matches[1]
        $args = $Matches[2]
    } elseif ($cmd -match '^(.*\.exe)(\s+.*)?$') {
        $exe = $Matches[1]
        $args = if ($Matches[2]) { $Matches[2].Trim() } else { "" }
    } else {
        $parts = $cmd.Split(" ", 2)
        $exe = $parts[0].Trim('"')
        if ($parts.Length -gt 1) { $args = $parts[1] }
    }

    Write-Host "EXE: $exe"
    Write-Host "ARGS: $args"

    # Tenta adicionar silent flag se for WinRAR ou similar e não houver args
    if (-not $args -and ($exe -like "*WinRAR*" -or $exe -like "*uninstall.exe")) {
        $args = "/S"
        Write-Host "Auto-adicionando /S para desinstalação silenciosa"
    }

    Start-Process -FilePath $exe -ArgumentList $args -Wait -ErrorAction SilentlyContinue
}

Write-Host "Desinstalação finalizada"
`;

  try {
    console.log(`[SOFT_ISOLATED] Robust Uninstall for "${appName}" on ${host}`);
    await softwareExec(host, uninstallScript, user, pass);
    return true;
  } catch (err) {
    console.error(`[SOFT_ISOLATED_ERROR] ${host}:`, err);
    return false;
  }
}

