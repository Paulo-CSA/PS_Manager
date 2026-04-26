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

  return new Promise<{ stdout: string; stderr: string; exitCode: number | null }>((resolve, reject) => {
    const isLocal = host === 'localhost' || host === '127.0.0.1';
    const uniqueId = Date.now() + '_' + Math.floor(Math.random() * 1000);
    const localOutFile = path.join(STORAGE_DIR, `out_${uniqueId}.txt`);

    let fullCommand = '';

    if (isLocal) {
      fullCommand = `cmd /c "${command} > \\"${localOutFile}\\" 2>&1"`;
    } else {
      const psexecPath = path.join(process.cwd(), 'psexec.exe');
      const remoteTemp = `C:\\out_${Math.floor(Math.random() * 10000)}.txt`;
      
      // Construct the command using user-validated escaping for local shell
      // ^> and ^& ensure these are passed to PsExec, while > at the end is for local redirection
      const remotePart = `cmd /c (${command}) ^> ${remoteTemp} 2^>^&1 ^& type ${remoteTemp} ^& timeout /t 20 /nobreak ^>nul ^& del /f /q ${remoteTemp}`;
      
      fullCommand = `"${psexecPath}" \\\\${host} -u "${username}" -p "${password}" -accepteula -nobanner -h ${remotePart} > "${localOutFile}" 2>&1`;
    }

    console.log(`[EXEC] ${host} | Command: ${fullCommand}`);

    const child = spawn('cmd.exe', ['/c', fullCommand], {
      shell: false,
      windowsHide: true,
    });

    const timeoutDuration = isScript ? 180000 : 120000;
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      if (fs.existsSync(localOutFile)) try { fs.unlinkSync(localOutFile); } catch(e) {}
      reject(new Error(`Timeout na execução para ${host} (${timeoutDuration/1000}s)`));
    }, timeoutDuration);

    child.on('close', (code) => {
      clearTimeout(timer);
      
      // Wait a bit for the file to be fully written
      setTimeout(() => {
        try {
          let output = '';
          if (fs.existsSync(localOutFile)) {
            const raw = fs.readFileSync(localOutFile);
            output = iconv.decode(raw, 'cp850');
            if (!output.trim()) output = iconv.decode(raw, 'utf-8');
            try { fs.unlinkSync(localOutFile); } catch(e) {}
          }
          console.log(`[EXEC] ${host} Finalizado | Code: ${code} | Out: ${output.length} bytes`);
          resolve({ stdout: output, stderr: '', exitCode: code });
        } catch (err) {
          reject(err);
        }
      }, 500);
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      if (fs.existsSync(localOutFile)) try { fs.unlinkSync(localOutFile); } catch(e) {}
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
