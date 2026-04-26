import net from 'net';
import express from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import { fileURLToPath } from 'url';
import bodyParser from 'body-parser';
import cors from 'cors';
import fs from 'fs';
import fsp from 'fs/promises';
import { spawn } from 'child_process';
import iconv from 'iconv-lite';
import { Buffer } from 'buffer';

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
    const content = await fsp.readFile(DB_FILE, 'utf-8');
    return JSON.parse(content);
  } catch (e) {
    return { machines: [], credentials: { username: '', password: '' } };
  }
}

async function writeDb(data: any) {
  await fsp.writeFile(DB_FILE, JSON.stringify(data, null, 2));
}

/**
 * Robust execution engine for Windows.
 * Handles PsExec and direct CMD execution for localhost.
 */
async function winExecute(options: {
  host: string;
  command: string;
  username?: string;
  password?: string;
  isScript?: boolean;
}) {
  const { host, command, username, password, isScript } = options;

  return new Promise<{ stdout: string; stderr: string; exitCode: number | null }>(async (resolve, reject) => {
    let executable = '';
    let args: string[] = [];

    const isLocal = host === 'localhost' || host === '127.0.0.1';

    if (isLocal) {
      executable = 'cmd.exe';
      args = ['/c', command];
    } else {
      executable = 'psexec.exe'; 
      args.push(`\\\\${host}`);

      if (username) args.push('-u', username);
      if (password) args.push('-p', password);

      args.push('-accepteula', '-nobanner', '-h'); 

      if (isScript) {
        args.push('-c', command); 
      } else {
        const uniqueId = Date.now() + '_' + Math.floor(Math.random() * 1000);
        const localBatPath = path.join(TEMP_BATCH_DIR, `cmd_${uniqueId}.bat`);
        const remoteOutFile = `C:\\psexec_temp_${uniqueId}.txt`;
        
        const batContent = `@echo off\r\n${command} > "${remoteOutFile}" 2>&1\r\nif exist "${remoteOutFile}" (\r\n  type "${remoteOutFile}"\r\n  timeout /t 1 /nobreak > nul 2>&1\r\n  del /f /q "${remoteOutFile}"\r\n)`;
        
        try {
          await fsp.writeFile(localBatPath, batContent);
          args.push('-c', localBatPath);
          
          const cleanupLocal = () => fs.unlink(localBatPath, () => {});
          
          const child = spawn(executable, args, { shell: false, windowsHide: true });
          let stdoutChunks: Buffer[] = [];
          let stderrChunks: Buffer[] = [];

          child.stdout.on('data', (d) => stdoutChunks.push(d));
          child.stderr.on('data', (d) => stderrChunks.push(d));

          const timer = setTimeout(() => {
            child.kill();
            cleanupLocal();
            reject(new Error('Timeout de 60s excedido.'));
          }, 60000);

          child.on('close', (code) => {
            clearTimeout(timer);
            cleanupLocal();
            const stdout = iconv.decode(Buffer.concat(stdoutChunks), 'cp850');
            const stderr = iconv.decode(Buffer.concat(stderrChunks), 'cp850');
            console.log(`[EXEC] Batch Result - Code: ${code} | Stdout: ${stdout.length} chars`);
            resolve({ stdout, stderr, exitCode: code });
          });

          child.on('error', (err) => {
            clearTimeout(timer);
            cleanupLocal();
            reject(err);
          });
          return;
        } catch (e) {
          return reject(new Error('Falha ao criar script temporário.'));
        }
      }
    }

    console.log(`[EXEC] Cmd: ${executable} ${args.join(' ')}`);

    const child = spawn(executable, args, {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'] 
    });

    let stdoutChunks: Buffer[] = [];
    let stderrChunks: Buffer[] = [];

    child.stdout.on('data', (data: Buffer) => {
      stdoutChunks.push(data);
    });

    child.stderr.on('data', (data: Buffer) => {
      stderrChunks.push(data);
    });

    const timeoutDuration = isScript ? 180000 : 60000;
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Timeout na execução remota (${timeoutDuration / 1000}s)`));
    }, timeoutDuration);

    child.on('close', (code) => {
      clearTimeout(timer);
      
      const stdoutRaw = Buffer.concat(stdoutChunks);
      const stderrRaw = Buffer.concat(stderrChunks);
      
      let stdout = iconv.decode(stdoutRaw, 'cp850');
      let stderr = iconv.decode(stderrRaw, 'cp850');

      if (!stdout.trim() && stdoutRaw.length > 0) {
        stdout = iconv.decode(stdoutRaw, 'utf-8');
      }
      if (!stderr.trim() && stderrRaw.length > 0) {
        stderr = iconv.decode(stderrRaw, 'utf-8');
      }

      console.log(`[EXEC] Close Code: ${code} | Stdout: ${stdoutRaw.length} bytes | Stderr: ${stderrRaw.length} bytes`);

      resolve({ stdout, stderr, exitCode: code });
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/**
 * Cleaner filter for PsExec output.
 */
function formatOutput(stdout: string, stderr: string): string {
  const combined = (stdout + '\n' + stderr).trim();
  if (!combined) return 'Vazio (nenhum dado retornado do console).';

  const filterPhrases = [
    'psexec v',
    'sysinternals',
    'copyright',
    'starting psexec service',
    'connecting to',
    'connected to',
    'exited on',
    'psexec.exe',
    'microsoft (r) windows (r)'
  ];

  const lines = combined.split('\n');
  const filtered = lines.filter(line => {
    const l = line.trim().toLowerCase();
    if (!l) return false;
    
    // Skip common informational noise
    if (filterPhrases.some(p => l.includes(p))) return false;
    
    // Skip common windows prompt patterns like C:\>
    if (/^[a-z]:\\.*>$/i.test(l)) return false;

    return true;
  });

  return filtered.join('\n').trim() || combined;
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
    
    const fileName = name.endsWith('.bat') ? name : `${name}.bat`;
    try {
      await fsp.writeFile(path.join(SCRIPTS_DIR, fileName), req.body);
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: 'Falha ao salvar script' });
    }
  });

  app.delete('/api/scripts/:name', async (req, res) => {
    try {
      await fsp.unlink(path.join(SCRIPTS_DIR, req.params.name));
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
