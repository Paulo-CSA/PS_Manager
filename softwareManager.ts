import { spawn } from 'child_process';
import iconv from 'iconv-lite';
import { Buffer } from 'buffer';
import fs from 'fs';
import path from 'path';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const SOFTWARE_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'

$paths = @(
    "Registry::HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*",
    "Registry::HKEY_LOCAL_MACHINE\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*"
)

# HKU (todos usuários)
$hkuPaths = Get-ChildItem Registry::HKEY_USERS | ForEach-Object {
    $_.PSPath + "\Software\Microsoft\Windows\CurrentVersion\Uninstall\*"
}

$paths += $hkuPaths

foreach ($path in $paths) {
    Get-ItemProperty $path -ErrorAction SilentlyContinue | ForEach-Object {
        if ($_.DisplayName) {
            $name = $_.DisplayName
            $ver = if ($_.DisplayVersion) { $_.DisplayVersion } else { "---" }
            $pub = if ($_.Publisher) { $_.Publisher } else { "---" }

            if ($name -notmatch 'Update|Hotfix|Security|Microsoft Visual C\+\+') {
                Write-Output "$name###$ver###$pub"
            }
        }
    }
}

# Fonte: Microsoft Store (para apps como BreeZip)
if (Get-Command Get-AppxPackage -ErrorAction SilentlyContinue) {
    Get-AppxPackage | Where-Object { $_.IsFramework -eq $false -and $_.Name -notmatch 'Microsoft\.' } | ForEach-Object {
        $friendlyName = if ($_.DisplayName) { $_.DisplayName } else { $_.Name }
        Write-Output "$friendlyName###$($_.Version)###Microsoft Store ($($_.Name))"
    }
}
`;

/**
 * Isolated execution logic for Software Management
 * Uses output redirection to a file on the remote machine for maximum reliability
 */
async function softwareExec(host: string, script: string, user?: string, pass?: string): Promise<string> {
  const psexec = 'psexec.exe';
  const auth = [];
  if (user) auth.push('-u', user);
  if (pass) auth.push('-p', pass);
  const baseArgs = [`\\\\${host}`, ...auth, '-accepteula', '-nobanner', '-h'];

  const uniqueId = Math.floor(Math.random() * 100000);
  const remoteFile = `C:\\Windows\\Temp\\sw_${uniqueId}.txt`;
  const smbPath = `\\\\${host}\\C$\\Windows\\Temp\\sw_${uniqueId}.txt`;

  const runPsExec = (args: string[], capture: boolean): Promise<{ out: string; err: string; code: number | null }> => {
    return new Promise((resolve, reject) => {
      const child = spawn(psexec, args, { shell: false, windowsHide: true });
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let outEnded = false;
      let errEnded = false;
      let exited = false;
      let exitCode: number | null = null;

      const attemptResolve = () => {
        if (exited && (outEnded || !capture) && (errEnded || !capture)) {
          clearTimeout(timeout);
          const out = capture ? iconv.decode(Buffer.concat(stdoutChunks), 'cp850').replace(/\0/g, '') : '';
          const err = capture ? iconv.decode(Buffer.concat(stderrChunks), 'cp850').replace(/\0/g, '') : '';
          resolve({ out, err, code: exitCode });
        }
      };

      const timeout = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('Timeout na execução remota'));
      }, 120000);

      if (capture) {
        child.stdout.on('data', d => stdoutChunks.push(d));
        child.stdout.on('end', () => { outEnded = true; attemptResolve(); });
        child.stderr.on('data', d => stderrChunks.push(d));
        child.stderr.on('end', () => { errEnded = true; attemptResolve(); });
      }

      child.on('close', code => {
        exitCode = code;
        exited = true;
        if (!capture) { outEnded = true; errEnded = true; }
        attemptResolve();
      });

      child.on('error', err => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  };

  try {
    // 1. Execute PowerShell script and redirect to file
    const encodedScript = Buffer.from(script, 'utf16le').toString('base64');
    const cmd = `powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encodedScript} > ${remoteFile} 2>&1`;
    
    console.log(`[SOFT_EXEC] redirecting to ${remoteFile} on ${host}`);
    await runPsExec([...baseArgs, 'cmd', '/c', cmd], false);
    
    await sleep(2000);

    // 2. Read output
    let finalOutput = '';
    if (fs.existsSync(smbPath)) {
      console.log(`[SOFT_EXEC] Reading via SMB: ${smbPath}`);
      const buf = fs.readFileSync(smbPath);
      finalOutput = iconv.decode(buf, 'cp850');
      if (!finalOutput.trim() && buf.length > 0) finalOutput = iconv.decode(buf, 'utf-8');
    } else {
      console.log(`[SOFT_EXEC] Falling back to remote read`);
      const readRes = await runPsExec([...baseArgs, 'cmd', '/c', `type ${remoteFile}`], true);
      finalOutput = readRes.out;
    }

    // 3. Cleanup
    spawn(psexec, [...baseArgs, 'cmd', '/c', `del /f /q ${remoteFile}`], { shell: false, windowsHide: true, stdio: 'ignore' }).unref();

    return finalOutput.replace(/\0/g, '');
  } catch (err: any) {
    console.error(`[SOFT_EXEC_ERROR] ${host}:`, err.message);
    throw err;
  }
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

# 1. Tentar Appx (Microsoft Store)
if (Get-Command Get-AppxPackage -ErrorAction SilentlyContinue) {
    # Procura pelo nome amigável ou pelo nome técnico (que pode estar no Publisher agora)
    $appx = Get-AppxPackage | Where-Object { 
        $_.Name -eq $appName -or 
        $_.PackageFullName -eq $appName -or 
        $_.DisplayName -eq $appName 
    } | Select-Object -First 1
    
    if ($appx) {
        Write-Host "Removendo Appx: $($appx.PackageFullName)"
        Remove-AppxPackage -Package $appx.PackageFullName -ErrorAction SilentlyContinue
        Write-Host "Desinstalação finalizada"
        exit 0
    }
}

# 2. Tentar Registro (Clássico)
$paths = @(
 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
 'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'
)

$app = Get-ItemProperty $paths -ErrorAction SilentlyContinue |
Where-Object { $_.DisplayName -like "*$appName*" -or $_.PSChildName -eq $appName } |
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

