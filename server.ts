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
  const tempFile = DB_FILE + '.tmp';
  await fsp.writeFile(tempFile, JSON.stringify(data, null, 2));
  await fsp.rename(tempFile, DB_FILE);
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

  return new Promise<{ stdout: string; stderr: string; exitCode: number | null }>((resolve, reject) => {
    const isLocal = host === 'localhost' || host === '127.0.0.1';
    
    let fullExecutionCommand = '';
    let thisCleanup: (() => void) | null = null;

    if (isLocal) {
      fullExecutionCommand = `cmd /c "${command}"`;
    } else {
      const psexec = 'psexec.exe';
      const auth = `${username ? `-u "${username}"` : ''} ${password ? `-p "${password}"` : ''}`;

      if (isScript) {
        // -c actually copies the file to the remote machine
        fullExecutionCommand = `${psexec} \\\\${host} ${auth} -accepteula -nobanner -h -c "${command}"`;
      } else {
        const uniqueId = Math.floor(Math.random() * 100000);
        const remoteOutFile = `C:\\Windows\\Temp\\out_${uniqueId}.txt`;
        const captureLogic = `(${command}) ^> ${remoteOutFile} 2^>^&1 ^& type ${remoteOutFile}`;
        
        fullExecutionCommand = `${psexec} \\\\${host} ${auth} -accepteula -nobanner -h cmd /c ${captureLogic}`;

        thisCleanup = () => {
          const cleanupCmd = `${psexec} \\\\${host} ${auth} -accepteula -nobanner -h cmd /c timeout /t 10 /nobreak ^>nul ^& del /f /q ${remoteOutFile}`;
          console.log(`[CLEANUP] Iniciando limpeza em ${host}: ${remoteOutFile}`);
          spawn(cleanupCmd, [], { shell: true, windowsHide: true, stdio: 'ignore' }).unref();
        };
      }
    }

    console.log(`[EXEC] ${host} | Executing: ${fullExecutionCommand}`);

    const child = spawn(fullExecutionCommand, [], {
      shell: true,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdoutChunks: Buffer[] = [];
    let stderrChunks: Buffer[] = [];

    child.stdout.on('data', (data: Buffer) => stdoutChunks.push(data));
    child.stderr.on('data', (data: Buffer) => stderrChunks.push(data));

    const timeoutDuration = isScript ? 180000 : 120000;
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      if (thisCleanup) thisCleanup();
      reject(new Error(`Timeout na execução para ${host} (${timeoutDuration / 1000}s)`));
    }, timeoutDuration);

    child.on('close', (code) => {
      clearTimeout(timer);
      if (thisCleanup) thisCleanup();

      const stdoutRaw = Buffer.concat(stdoutChunks);
      const stderrRaw = Buffer.concat(stderrChunks);
      
      let stdout = iconv.decode(stdoutRaw, 'cp850');
      let stderr = iconv.decode(stderrRaw, 'cp850');

      if (!stdout.trim() && stdoutRaw.length > 0) stdout = iconv.decode(stdoutRaw, 'utf-8');
      if (!stderr.trim() && stderrRaw.length > 0) stderr = iconv.decode(stderrRaw, 'utf-8');

      console.log(`[EXEC] ${host} Finalizado | Code: ${code} | Out: ${stdoutRaw.length} bytes`);
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
    'copyright',
    'sysinternals',
    'starting psexec service',
    'connecting to',
    'connected to',
    'exited on',
    'psexec.exe'
  ];

  const lines = combined.split('\n');
  const filtered = lines.filter(line => {
    const l = line.trim().toLowerCase();
    if (!l) return true; // Keep empty lines for spacing
    
    // Skip PsExec specific noise only
    if (filterPhrases.some(p => l.includes(p))) return false;
    
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
