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

  const runSingle = (cmdStr: string, capture: boolean): Promise<{ out: string; err: string; code: number | null }> => {
    return new Promise((resolve, reject) => {
      const child = spawn(cmdStr, [], { 
        shell: true, 
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });
      
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      const timeout = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('Processo demorou muito para responder'));
      }, 90000);

      child.stdout.on('data', (d) => { if (capture) stdoutChunks.push(d); });
      child.stderr.on('data', (d) => { if (capture) stderrChunks.push(d); });

      child.on('close', (code) => {
        clearTimeout(timeout);
        let out = '';
        let err = '';
        if (capture) {
          const outBuf = Buffer.concat(stdoutChunks);
          const errBuf = Buffer.concat(stderrChunks);
          
          out = iconv.decode(outBuf, 'cp850');
          if (!out.trim() && outBuf.length > 0) out = iconv.decode(outBuf, 'utf-8');
          
          err = iconv.decode(errBuf, 'cp850');
          if (!err.trim() && errBuf.length > 0) err = iconv.decode(errBuf, 'utf-8');
        }
        resolve({ out, err, code });
      });

      child.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  };

  if (isLocal) {
    console.log(`[EXEC] Local | Command: ${command}`);
    const res = await runSingle(`cmd /c "${command}"`, true);
    return { stdout: res.out, stderr: res.err, exitCode: res.code };
  }

  const psexec = 'psexec.exe';
  const auth = `${username ? `-u "${username}"` : ''} ${password ? `-p "${password}"` : ''}`;
  const baseAuth = `${psexec} \\\\${host} ${auth} -accepteula -nobanner -h`;

  try {
    if (isScript) {
      console.log(`[EXEC] ${host} | Script: ${command}`);
      const scriptExec = `${baseAuth} -c "${command}"`;
      const res = await runSingle(scriptExec, true);
      return { stdout: res.out, stderr: res.err, exitCode: res.code };
    } else {
      const uniqueId = Math.floor(Math.random() * 100000);
      const remoteOutFile = `C:\\Windows\\Temp\\out_${uniqueId}.txt`;

      // 1. CREATE FILE
      console.log(`[EXEC] ${host} [STEP 1] Criando: ${remoteOutFile}`);
      const createCmd = `${baseAuth} cmd /c "(${command}) > ${remoteOutFile} 2>&1"`;
      await runSingle(createCmd, false);

      await sleep(5000);

      // 2. READ FILE (Com marcadores para isolar o Base64)
      console.log(`[EXEC] ${host} [STEP 2] Lendo via Base64 Protegido: ${remoteOutFile}`);
      const readCmd = `${baseAuth} powershell -NoProfile -ExecutionPolicy Bypass -Command "$b=[Convert]::ToBase64String([IO.File]::ReadAllBytes('${remoteOutFile}')); Write-Output '---B64_START---'; Write-Output $b; Write-Output '---B64_END---'"`;
      const readRes = await runSingle(readCmd, true);
      
      let finalOutput = '';
      const b64Match = readRes.out.match(/---B64_START---([\s\S]*?)---B64_END---/);
      
      if (b64Match && b64Match[1]) {
        try {
          const b64Data = b64Match[1].trim().replace(/[\r\n\s]/g, '');
          const buffer = Buffer.from(b64Data, 'base64');
          // Tentamos CP850 primeiro (padrão cmd), depois UTF-8
          finalOutput = iconv.decode(buffer, 'cp850');
          if (!finalOutput.trim()) finalOutput = iconv.decode(buffer, 'utf-8');
          finalOutput = finalOutput.replace(/\0/g, '');
        } catch (decErr) {
          console.error(`[DECODE ERROR] ${host}:`, decErr);
          finalOutput = "Erro ao decodificar dados do arquivo.";
        }
      } else {
        console.warn(`[READ WARNING] Marcadores base64 não encontrados em ${host}. Raw output len: ${readRes.out.length}`);
        // Fallback: se não achou marcadores, mostra o stdout bruto mas limpo (pode vir com banners do psexec)
        finalOutput = readRes.out.replace(/---B64_START---|---B64_END---/g, '').trim();
      }

      console.log(`[READ INFO] ${host} caracteres finais: ${finalOutput.length}`);

      // 3. DELETE FILE
      console.log(`[EXEC] ${host} [STEP 3] Limpando: ${remoteOutFile}`);
      const cleanupCmd = `${baseAuth} cmd /c "ping 127.0.0.1 -n 10 >nul & del /f /q ${remoteOutFile}"`;
      spawn(cleanupCmd, [], { shell: true, windowsHide: true, stdio: 'ignore' }).unref();

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
