import net from 'net';
import express from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import { fileURLToPath } from 'url';
import bodyParser from 'body-parser';
import cors from 'cors';
import fs from 'fs';
import fsp from 'fs/promises';
import { spawn, execFile } from 'child_process';
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

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Robust execution engine for Windows.
 * Handles PsExec and direct CMD execution for localhost.
 * Executes in 3 stages for remote machines: 1. Create, 2. Read, 3. Cleanup.
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

  // Using execFile with very large maxBuffer (100MB) for full output capture
  const runArgs = (executable: string, args: string[], capture: boolean): Promise<{ out: string; err: string; code: number | null }> => {
    return new Promise((resolve, reject) => {
      console.log(`[EXEC_FILE] ${executable} ${args.join(' ')}`);
      
      const options = {
        encoding: 'buffer' as const,
        maxBuffer: 100 * 1024 * 1024, // 100 MB buffer
        windowsHide: true,
        timeout: 240000, // 4 minutes timeout
      };

      execFile(executable, args, options, (error, stdout, stderr) => {
        let out = '';
        let err = '';
        let code: number | null = 0;

        if (error) {
          code = typeof error.code === 'number' ? error.code : 1;
        }

        if (capture) {
          const decodeBuffer = (buf: Buffer) => {
            if (!buf || buf.length === 0) return '';
            
            // Try to detect UTF-16 (BOM or common pattern)
            if (buf.length >= 2 && ((buf[0] === 0xFF && buf[1] === 0xFE) || (buf[0] === 0xFE && buf[1] === 0xFF))) {
                 return iconv.decode(buf, 'utf16');
            }
            
            let decoded = iconv.decode(buf, 'cp850');
            // Check if it looks empty or corrupted (e.g. lots of nulls)
            if (!decoded.trim() && buf.length > 0) {
              decoded = iconv.decode(buf, 'utf-8');
            }
            return decoded.replace(/\0/g, ''); // Clean nulls regardless
          };

          out = decodeBuffer(stdout);
          err = decodeBuffer(stderr);
        }

        resolve({ out, err, code });
      });
    });
  };

  if (isLocal) {
    console.log(`[EXEC] Local | Command: ${command}`);
    const res = await runArgs('cmd.exe', ['/c', command], true);
    return { stdout: res.out, stderr: res.err, exitCode: res.code };
  }

  const psexec = 'psexec.exe';
  const baseArgs = [`\\\\${host}`];
  if (username) {
    baseArgs.push('-u', username);
  }
  if (password) {
    baseArgs.push('-p', password);
  }
  baseArgs.push('-accepteula', '-nobanner', '-h');

  try {
    if (isScript) {
      console.log(`[EXEC] ${host} | Script: ${command}`);
      const res = await runArgs(psexec, [...baseArgs, '-c', command], true);
      return { stdout: res.out, stderr: res.err, exitCode: res.code };
    } else {
      const uniqueId = Math.floor(Math.random() * 100000);
      const remoteOutFile = `C:\\Windows\\Temp\\out_${uniqueId}.txt`;

      // 1. CREATE FILE
      console.log(`[EXEC] ${host} [STEP 1] Criando: ${remoteOutFile}`);
      const createArgs = [...baseArgs, 'cmd', '/c', `(${command}) > ${remoteOutFile} 2>&1`].filter(v => v !== '');
      await runArgs(psexec, createArgs, false);

      await sleep(10000);

      // 2. READ FILE
      console.log(`[EXEC] ${host} [STEP 2] Lendo via Hex: ${remoteOutFile}`);
      // Using HEX ensures NO truncation and NO encoding issues during transmission
      const readArgs = [...baseArgs, 'powershell', '-NoProfile', '-Command', 
        `$p='${remoteOutFile}'; if(Test-Path $p){ $b=[IO.File]::ReadAllBytes($p); '---HEX---'; [System.BitConverter]::ToString($b); '---END---' }`
      ].filter(v => v !== '');
      const readRes = await runArgs(psexec, readArgs, true);
      
      let finalOutput = '';
      const hexMatch = readRes.out.match(/---HEX---([\s\S]*?)---END---/);
      
      if (hexMatch && hexMatch[1]) {
        try {
          const hexStr = hexMatch[1].trim().replace(/[\r\n\s-]/g, '');
          const buffer = Buffer.from(hexStr, 'hex');
          finalOutput = iconv.decode(buffer, 'cp850');
          if (!finalOutput.trim()) finalOutput = iconv.decode(buffer, 'utf-8');
          finalOutput = finalOutput.replace(/\0/g, '');
        } catch (decErr) {
          console.error(`[HEX ERROR] ${host}:`, decErr);
          finalOutput = "Erro ao decodificar HEX.";
        }
      } else {
        finalOutput = readRes.out.replace(/---HEX---|---END---/g, '').trim();
      }

      console.log(`[READ INFO] ${host} final length: ${finalOutput.length}`);

      // 3. DELETE FILE (Detached Cleanup)
      console.log(`[EXEC] ${host} [STEP 3] Limpando: ${remoteOutFile}`);
      const cleanupArgs = [...baseArgs, 'cmd', '/c', `ping 127.0.0.1 -n 15 >nul & del /f /q ${remoteOutFile}`].filter(v => v !== '');
      spawn(psexec, cleanupArgs, { shell: false, windowsHide: true, stdio: 'ignore' }).unref();

      return { stdout: finalOutput, stderr: readRes.err, exitCode: readRes.code };
    }
  } catch (err: any) {
    console.error(`[EXEC ERROR] ${host}:`, err.message);
    throw err;
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
