import net from 'net';
import express from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import bodyParser from 'body-parser';
import cors from 'cors';
import fs from 'fs';
import fsp from 'fs/promises';
import { spawn, execFile, exec } from 'child_process';
import iconv from 'iconv-lite';
import { Buffer } from 'buffer';
import { getRemoteSoftware, uninstallRemoteSoftware } from './softwareManager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuration for Persistence
const STORAGE_DIR = path.join(process.cwd(), 'data_storage');
const DB_FILE = path.join(STORAGE_DIR, 'db.json');
const SCRIPTS_DIR = path.join(process.cwd(), 'remote_scripts');
const TEMP_BATCH_DIR = path.join(process.cwd(), 'temp_batches');

// Ensure directories exist
[STORAGE_DIR, SCRIPTS_DIR, TEMP_BATCH_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    console.log(`[INIT] Diretório criado: ${dir}`);
  }
});

// Database Helpers
async function readDb() {
  try {
    if (!fs.existsSync(DB_FILE)) {
      return { 
        machines: [], 
        credentials: { username: '', password: '' },
        ous: ['GERAL'] 
      };
    }
    const content = await fsp.readFile(DB_FILE, 'utf-8');
    const data = JSON.parse(content);
    // Migration/Ensure fields
    if (!data.ous) data.ous = ['GERAL'];
    if (!data.machines) data.machines = [];
    return data;
  } catch (e) {
    return { 
      machines: [], 
      credentials: { username: '', password: '' },
      ous: ['GERAL'] 
    };
  }
}

async function writeDb(data: any) {
  try {
    if (!fs.existsSync(STORAGE_DIR)) {
      await fsp.mkdir(STORAGE_DIR, { recursive: true });
    }
    const content = JSON.stringify(data, null, 2);
    // Write directly if rename is failing in this environment
    await fsp.writeFile(DB_FILE, content);
  } catch (err: any) {
    console.error(`[DB_ERROR] Falha ao escrever banco: ${err.message}`);
    // Fallback attempt
    try {
      fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
    } catch (innerErr) {
      console.error(`[DB_CRITICAL] Falha total na persistência:`, innerErr);
    }
    throw err;
  }
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Robust execution engine for Windows.
 * Handles PsExec and direct CMD execution.
 */
async function winExecute(options: {
  host: string;
  command: string;
  username?: string;
  password?: string;
  isScript?: boolean;
}): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  const { host, command, username, password, isScript } = options;
  const isLocal = host === 'localhost' || host === '127.0.0.1';

  const runArgs = (executable: string, args: string[], capture: boolean): Promise<{ out: string; err: string; code: number | null }> => {
    return new Promise((resolve, reject) => {
      const child = spawn(executable, args, { 
        shell: false, 
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });
      
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let stdoutEnded = false;
      let stderrEnded = false;
      let processExited = false;
      let exitCode: number | null = null;

      const attemptResolve = () => {
        if (processExited && stdoutEnded && stderrEnded) {
          clearTimeout(timeout);
          let out = '';
          let err = '';

          if (capture) {
            const decodeBuffer = (buf: Buffer) => {
              if (!buf || buf.length === 0) return '';
              let decoded = iconv.decode(buf, 'cp850');
              if (!decoded.trim() && buf.length > 0) decoded = iconv.decode(buf, 'utf-8');
              return decoded.replace(/\0/g, ''); 
            };
            out = decodeBuffer(Buffer.concat(stdoutChunks));
            err = decodeBuffer(Buffer.concat(stderrChunks));
          }
          resolve({ out, err, code: exitCode });
        }
      };
      
      const timeout = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`Timeout na execução (${executable})`));
      }, 300000);

      if (capture) {
        child.stdout.on('data', (d) => stdoutChunks.push(d));
        child.stdout.on('end', () => { stdoutEnded = true; attemptResolve(); });
        child.stderr.on('data', (d) => stderrChunks.push(d));
        child.stderr.on('end', () => { stderrEnded = true; attemptResolve(); });
      } else {
        stdoutEnded = true;
        stderrEnded = true;
      }

      child.on('close', (code) => {
        exitCode = code;
        processExited = true;
        attemptResolve();
      });

      child.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  };

  if (isLocal) {
    const res = await runArgs('cmd.exe', ['/c', command], true);
    return { stdout: res.out, stderr: res.err, exitCode: res.code };
  }

  const psexec = 'psexec.exe';
  const authArgs = [];
  if (username) authArgs.push('-u', username);
  if (password) authArgs.push('-p', password);
  const baseArgs = [`\\\\${host}`, ...authArgs, '-accepteula', '-nobanner', '-h'];

  try {
    if (isScript) {
      const res = await runArgs(psexec, [...baseArgs, '-c', command], true);
      return { stdout: res.out, stderr: res.err, exitCode: res.code };
    } else {
      const uniqueId = Math.floor(Math.random() * 100000);
      const remoteFile = `C:\\Windows\\Temp\\out_${uniqueId}.txt`;
      const smbPath = `\\\\${host}\\C$\\Windows\\Temp\\out_${uniqueId}.txt`;

      // 1. EXECUTE AND REDIRECT ON REMOTE
      console.log(`[EXEC] ${host} [STAGE 1] Redirecting to ${remoteFile}`);
      await runArgs(psexec, [...baseArgs, 'cmd', '/c', `(${command}) > ${remoteFile} 2>&1`], false);

      await sleep(3000); // Wait for flush

      // 2. READ OUTPUT
      let finalOutput = '';
      
      try {
        // Method A: Direct SMB Core access (Most robust for large data)
        if (fs.existsSync(smbPath)) {
          const buf = fs.readFileSync(smbPath);
          finalOutput = iconv.decode(buf, 'cp850');
          if (!finalOutput.trim() && buf.length > 0) finalOutput = iconv.decode(buf, 'utf-8');
        } else {
          // Method B: PowerShell direct read fallback
          const readRes = await runArgs(psexec, [...baseArgs, 'powershell', '-NoProfile', '-Command', `[IO.File]::ReadAllText('${remoteFile}')`], true);
          finalOutput = readRes.out;
        }
      } catch (readErr) {
        // Method C: Last resort CMD type
        const readRes = await runArgs(psexec, [...baseArgs, 'cmd', '/c', `type ${remoteFile}`], true);
        finalOutput = readRes.out;
      }

      console.log(`[EXEC] ${host} Completed. Length: ${finalOutput.length}`);

      // 3. CLEANUP (Async)
      spawn(psexec, [...baseArgs, 'cmd', '/c', `del /f /q ${remoteFile}`], { shell: false, windowsHide: true, stdio: 'ignore' }).unref();

      return { stdout: finalOutput.replace(/\0/g, ''), stderr: '', exitCode: 0 };
    }
  } catch (err: any) {
    console.error(`[EXEC ERROR] ${host}:`, err.message);
    return { stdout: '', stderr: err.message, exitCode: 1 };
  }
}

/**
 * Cleaner filter for PsExec output.
 */
function formatOutput(stdout: string, stderr: string): string {
  const combined = (stdout + '\n' + stderr).trim();
  if (!combined) return 'Vazio (nenhum dado retornado do console).';
  return combined;
}

async function startServer() {
  const app = express();
  const port = Number(process.env.PORT) || 3000;

  app.use(cors());
  app.use(bodyParser.json());

  // --- Persistence Routes ---
  app.get('/api/data', async (req, res) => {
    res.json(await readDb());
  });

  app.post('/api/ous', async (req, res) => {
    const { ous } = req.body;
    if (!Array.isArray(ous)) return res.status(400).json({ error: 'Array de OUs obrigatório' });
    const db = await readDb();
    db.ous = ous;
    await writeDb(db);
    res.json({ success: true });
  });

  app.post('/api/ps-test', async (req, res) => {
    const { host, user, pass } = req.body;
    try {
      const psexec = 'psexec.exe';
      const auth = [];
      if (user) auth.push('-u', user);
      if (pass) auth.push('-p', pass);
      
      const args = [`\\\\${host}`, ...auth, '-accepteula', '-nobanner', '-n', '5', 'cmd', '/c', 'echo 1'];
      const child = spawn(psexec, args, { shell: false, windowsHide: true });
      
      const timeout = setTimeout(() => {
        child.kill();
      }, 10000);

      child.on('close', (code) => {
        clearTimeout(timeout);
        res.json({ success: code === 0 });
      });

      child.on('error', () => {
        clearTimeout(timeout);
        res.json({ success: false });
      });
    } catch (e) {
      res.json({ success: false });
    }
  });

  app.post('/api/machines', async (req, res) => {
    const { machines } = req.body;
    const db = await readDb();
    db.machines = machines;
    await writeDb(db);
    res.json({ success: true });
  });

  app.post('/api/credentials', async (req, res) => {
    const { credentials } = req.body;
    const db = await readDb();
    db.credentials = credentials;
    await writeDb(db);
    res.json({ success: true });
  });

  // --- Network Utilities ---
  app.post('/api/ping', async (req, res) => {
    const { hosts } = req.body;
    if (!Array.isArray(hosts)) return res.status(400).json({ error: 'Array de hosts obrigatório' });

    const results = await Promise.all(hosts.map(async (host) => {
      return new Promise((resolve) => {
        const socket = new net.Socket();
        socket.setTimeout(2000);
        
        socket.on('connect', () => {
          socket.destroy();
          resolve({ host, alive: true });
        });
        
        socket.on('timeout', () => {
          socket.destroy();
          resolve({ host, alive: false });
        });
        
        socket.on('error', () => {
          socket.destroy();
          resolve({ host, alive: false });
        });

        // Use SMB port 445 for Windows machine discovery
        socket.connect(445, host);
      });
    }));

    res.json(results);
  });

  // --- Scripts Management ---
  app.get('/api/scripts', async (req, res) => {
    try {
      const files = await fsp.readdir(SCRIPTS_DIR);
      res.json({ scripts: files.filter(f => f.endsWith('.bat')) });
    } catch (e) {
      res.status(500).json({ error: 'Falha ao listar scripts' });
    }
  });

  app.post('/api/scripts/upload', express.text({ limit: '1mb' }), async (req, res) => {
    const { name } = req.query;
    if (!name || typeof name !== 'string') return res.status(400).json({ error: 'Nome de arquivo inválido' });
    
    const safeName = path.basename(name);
    const fileName = safeName.endsWith('.bat') ? safeName : `${safeName}.bat`;
    try {
      await fsp.writeFile(path.join(SCRIPTS_DIR, fileName), req.body);
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: 'Falha ao salvar script' });
    }
  });

  app.delete('/api/scripts/:name', async (req, res) => {
    try {
      const safeName = path.basename(req.params.name);
      await fsp.unlink(path.join(SCRIPTS_DIR, safeName));
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: 'Falha ao remover script' });
    }
  });

  // --- Execution Routes ---
  app.post('/api/exec-script', async (req, res) => {
    const { host, scriptName } = req.body;
    const db = await readDb();
    const { username, password } = db.credentials;

    if (!username || !password) return res.status(400).json({ error: 'Credenciais não configuradas' });

    const scriptPath = path.join(SCRIPTS_DIR, scriptName);
    if (!fs.existsSync(scriptPath)) return res.status(404).json({ error: 'Script não encontrado' });

    try {
      const result = await winExecute({
        host,
        command: scriptPath,
        username,
        password,
        isScript: true
      });
      res.json({ output: formatOutput(result.stdout, result.stderr) });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Erro na execução do script' });
    }
  });

  app.post('/api/shell', async (req, res) => {
    const { host, command } = req.body;
    const db = await readDb();
    const { username, password } = db.credentials;

    if (!username || !password) return res.status(400).json({ error: 'Credenciais não configuradas' });

    try {
      const result = await winExecute({ host, command, username, password });
      res.json({ output: formatOutput(result.stdout, result.stderr) });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Falha na conexão remota' });
    }
  });

  app.post('/api/apps', async (req, res) => {
    const { host } = req.body;
    const db = await readDb();
    const { username, password } = db.credentials;

    if (!host) return res.status(400).json({ error: 'Host é obrigatório' });

    try {
      const apps = await getRemoteSoftware(host, username, password);
      res.json({ apps });
    } catch (err: any) {
      res.status(500).json({ error: 'Falha ao buscar inventário de software' });
    }
  });

  app.post('/api/apps/uninstall', async (req, res) => {
    const { host, appName } = req.body;
    const db = await readDb();
    const { username, password } = db.credentials;

    if (!host || !appName) return res.status(400).json({ error: 'Host e Nome do App são obrigatórios' });

    try {
      const success = await uninstallRemoteSoftware(host, appName, username, password);
      res.json({ success });
    } catch (err: any) {
      res.status(500).json({ error: 'Falha ao desinstalar aplicativo' });
    }
  });

  app.post('/api/exec', async (req, res) => {
    const { hosts, command, username, password } = req.body;
    if (!hosts || !command) return res.status(400).json({ error: 'Dados incompletos' });

    try {
      const results = await Promise.all(hosts.map(async (host: string) => {
        try {
          const result = await winExecute({ host, command, username, password });
          return { host, status: 'success', output: formatOutput(result.stdout, result.stderr) };
        } catch (err: any) {
          return { host, status: 'failed', output: err.message || 'Erro de execução' };
        }
      }));
      res.json({ results });
    } catch (err) {
      res.status(500).json({ error: 'Erro interno no processamento em massa' });
    }
  });

  // --- Web Serving ---
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(port, '0.0.0.0', () => {
    console.log(`[READY] Servidor PC_MANAGER rodando em http://0.0.0.0:${port}`);
  });
}

startServer().catch(err => {
  console.error('[FATAL] Erro ao iniciar servidor:', err);
});
