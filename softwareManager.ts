import { spawn } from 'child_process';
import iconv from 'iconv-lite';
import { Buffer } from 'buffer';

const SOFTWARE_SCRIPT = `$paths = @('HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*', 'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*', 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'); Get-ItemProperty $paths -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -and ($_.Publisher -notmatch 'Microsoft') -and ($_.DisplayName -notmatch \"^Windows \") } | ForEach-Object { write-host \"$($_.DisplayName)###$($_.DisplayVersion)###$($_.Publisher)\" }`;

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

$app = Get-ItemProperty $paths -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -eq $appName } | Select-Object -First 1

if (-not $app) {
    Write-Error "Aplicativo não encontrado"
    exit 1
}

$uninstallString = $app.UninstallString
if (-not $uninstallString) {
    Write-Error "Nenhuma string de desinstalação encontrada"
    exit 1
}

Write-Host "Desinstalando: $($app.DisplayName)"
Write-Host "Comando original: $uninstallString"

if ($uninstallString -like "*msiexec.exe*") {
    # Para MSI, garante que use /x e adiciona /quiet /norestart
    $guid = if ($uninstallString -match '{[A-Z0-9-]+}') { $matches[0] } else { $uninstallString }
    $cmd = "msiexec.exe /x $guid /quiet /norestart"
    Write-Host "Executando MSI: $cmd"
    Start-Process msiexec.exe -ArgumentList "/x", "$guid", "/quiet", "/norestart" -Wait
}
else {
    # Para executáveis (EXE), tenta identificar flags silenciosas
    $silentFlags = @("/S", "/s", "/silent", "/verysilent", "/quiet", "/qn", "-s", "-S", "-silent", "-quiet")
    
    # Limpa a string (remove aspas se for o caminho todo)
    $exePath = ""
    $args = ""
    
    if ($uninstallString -match '^\"([^\"]+)\" (.*)$') {
        $exePath = $matches[1]
        $args = $matches[2]
    } elseif ($uninstallString -match '^([^ ]+) (.*)$') {
        $exePath = $matches[1]
        $args = $matches[2]
    } else {
        $exePath = $uninstallString.Trim('\"')
    }

    # Verifica se já tem alguma flag silenciosa
    $hasSilent = $false
    foreach ($flag in $silentFlags) {
        if ($args -like "*$flag*") {
            $hasSilent = $true
            break
        }
    }

    if (-not $hasSilent) {
        # Adiciona flags comuns de instalação silenciosa se não houver
        # Tenta /S primeiro (comum em NSIS/Inno Setup)
        $args += " /S /quiet /silent"
    }

    Write-Host "Executando EXE: $exePath $args"
    Start-Process $exePath -ArgumentList $args -Wait -ErrorAction SilentlyContinue
}
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

