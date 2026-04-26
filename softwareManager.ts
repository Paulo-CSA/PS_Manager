import { spawn } from 'child_process';
import iconv from 'iconv-lite';
import { Buffer } from 'buffer';

const SOFTWARE_REGISTRY_COMMAND = `powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-ItemProperty HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*, HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\* -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -and ($_.Publisher -notmatch \\"Microsoft\\") -and ($_.DisplayName -notmatch \\"^Microsoft\\") } | Select-Object @{n='Name';e={$_.DisplayName}}, @{n='Version';e={$_.DisplayVersion}}, @{n='Publisher';e={$_.Publisher}} | Sort-Object Name | ConvertTo-Json -Compress"`;

/**
 * Isolated execution logic for Software Management
 */
async function softwareExec(host: string, command: string, user?: string, pass?: string): Promise<string> {
  const psexec = 'psexec.exe';
  const auth = [];
  if (user) auth.push('-u', user);
  if (pass) auth.push('-p', pass);

  // We use direct execution with output capture for simplicity and isolation
  const args = [`\\\\${host}`, ...auth, '-accepteula', '-nobanner', '-h', 'cmd', '/c', command];

  return new Promise((resolve, reject) => {
    const child = spawn(psexec, args, { shell: false, windowsHide: true });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout.on('data', (d) => stdoutChunks.push(d));
    child.stderr.on('data', (d) => stderrChunks.push(d));

    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Timeout na consulta de software'));
    }, 60000);

    child.on('close', (code) => {
      clearTimeout(timeout);
      const buf = Buffer.concat(stdoutChunks);
      let out = iconv.decode(buf, 'cp850');
      // Fallback if CP850 seems empty but buffer has data
      if (!out.trim() && buf.length > 0) out = iconv.decode(buf, 'utf-8');
      
      resolve(out.replace(/\0/g, '')); // Remove null bytes
    });

    child.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

/**
 * Robust JSON extraction from raw output
 */
function extractJson(raw: string): any[] {
  try {
    // Look for the start and end of a JSON structure (array or object)
    const startIndex = raw.indexOf('[');
    const lastIndex = raw.lastIndexOf(']');
    
    let jsonStr = '';
    if (startIndex !== -1 && lastIndex !== -1 && lastIndex > startIndex) {
      jsonStr = raw.substring(startIndex, lastIndex + 1);
    } else {
      const objStart = raw.indexOf('{');
      const objEnd = raw.lastIndexOf('}');
      if (objStart !== -1 && objEnd !== -1 && objEnd > objStart) {
        jsonStr = `[${raw.substring(objStart, objEnd + 1)}]`;
      }
    }

    if (!jsonStr.trim()) return [];

    // Remove any trailing commas that PowerShell might leave if not careful (though ConvertTo-Json -Compress is usually clean)
    // and remove control characters
    const cleanStr = jsonStr.replace(/[\x00-\x1F\x7F-\x9F]/g, "").trim();
    
    try {
      const data = JSON.parse(cleanStr);
      return Array.isArray(data) ? data : [data];
    } catch (parseErr) {
      // If parsing failed, it might be due to multiple objects not wrapped in an array
      // though we tried to wrap them. Let's try to fix common issues.
      console.warn('[SOFTWARE_PARSER_WARN] JSON.parse failed, attempting repair:', parseErr);
      
      // Attempt to wrap in array if it looks like multiple objects {}{}{}
      if (cleanStr.startsWith('{') && !cleanStr.startsWith('[{')) {
         try {
           const wrapped = `[${cleanStr.replace(/}\s*{/g, '},{')}]`;
           const data = JSON.parse(wrapped);
           return Array.isArray(data) ? data : [data];
         } catch (e2) {
           return [];
         }
      }
      return [];
    }
  } catch (e) {
    console.error('[SOFTWARE_PARSER_ERROR] Fail to parse JSON:', e);
    // If it fails, maybe the JSON was cut off or has junk inside.
    // Last ditch effort: try to clean line by line
    return [];
  }
}

export async function getRemoteSoftware(host: string, user?: string, pass?: string): Promise<any[]> {
  try {
    console.log(`[SOFT_ISOLATED] Querying ${host}`);
    const rawOutput = await softwareExec(host, SOFTWARE_REGISTRY_COMMAND, user, pass);
    const apps = extractJson(rawOutput);
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
    const output = await softwareExec(host, uninstallCmd, user, pass);
    // Usually code 0 is enough, but we just check if it finished without native error
    return true;
  } catch (err) {
    console.error(`[SOFT_ISOLATED_ERROR] ${host}:`, err);
    return false;
  }
}
