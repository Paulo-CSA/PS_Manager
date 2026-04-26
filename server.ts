import net from 'net';
import express from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import { fileURLToPath } from 'url';

import bodyParser from 'body-parser';
import cors from 'cors';
import fs from 'fs';
import fsp from 'fs/promises';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(process.cwd(), 'server_storage');
const DATA_FILE = path.join(DATA_DIR, 'persistence.json');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR);
  console.log(`>>> Criado diretório de persistência em: ${DATA_DIR}`);
}

// Helper to read/write JSON database
async function readDb() {
  try {
    const data = await fsp.readFile(DATA_FILE, 'utf-8');
    return JSON.parse(data);
  } catch (e) {
    return { machines: [], credentials: {} };
  }
}

async function writeDb(data: any) {
  await fsp.writeFile(DATA_FILE, JSON.stringify(data, null, 2));
}

import { spawn, exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

/**
 * Nova implementação robusta do execWin usando spawn para capturar saída em tempo real
 * e resolver problemas de buffer/captura do PsExec no Windows.
 */
async function execWin(options: { 
  host: string, 
  command?: string, 
  username?: string, 
  password?: string, 
  isScript?: boolean, 
  scriptPath?: string 
}) {
  return new Promise<{ stdout: string, stderr: string, exitCode: number | null }>((resolve, reject) => {
    const { host, command, username, password, isScript, scriptPath } = options;
    
    // Se for localhost, executa direto sem PsExec
    if (host === 'localhost' || host === '127.0.0.1') {
      const child = spawn('cmd.exe', ['/c', command || ''], { shell: true });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => stdout += d.toString());
      child.stderr.on('data', (d) => stderr += d.toString());
      child.on('close', (code) => resolve({ stdout, stderr, exitCode: code }));
      child.on('error', reject);
      return;
    }

    const args = [`\\\\${host}`];
    
    if (username) args.push('-u', username);
    if (password) args.push('-p', password);
    
    args.push('-accepteula', '-nobanner');
    
    if (isScript && scriptPath) {
      args.push('-c', scriptPath);
    } else if (command) {
      // cmd /c garante que o comando seja interpretado corretamente pelo ambiente Windows remoto
      args.push('cmd', '/c', command);
    }

    console.log(`[EXEC_WIN_SPAWN] Comando: psexec ${args.join(' ')}`);

    const child = spawn('psexec', args, {
      shell: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => {
      const chunk = data.toString();
      stdout += chunk;
    });

    child.stderr.on('data', (data) => {
      const chunk = data.toString();
      stderr += chunk;
    });

    // Timeout de segurança
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error('Tempo limite de execução excedido (PsExec)'));
    }, 60000);

    child.on('close', (code) => {
      clearTimeout(timeout);
      resolve({ stdout, stderr, exitCode: code });
    });

    child.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

async function startServer() {
  const app = express();
  const port = Number(process.env.PORT) || 3000;

  app.use(cors());
  app.use(bodyParser.json());

  // --- Persistent Storage API ---
  app.get('/api/data', async (req, res) => {
    const db = await readDb();
    res.json(db);
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

  // Verificação de conectividade (usando porta 445/SMB em vez de ICMP)
  app.post('/api/ping', async (req, res) => {
    const { hosts } = req.body;
    if (!Array.isArray(hosts)) return res.status(400).json({ error: 'Hosts em formato inválido' });
    
    try {
      const results = await Promise.all(
        hosts.map(async (host) => {
          return new Promise((resolve) => {
            const socket = new net.Socket();
            const timeout = 2500;
            let alive = false;

            socket.setTimeout(timeout);
            socket.on('connect', () => {
              alive = true;
              socket.destroy();
            });
            socket.on('timeout', () => {
              socket.destroy();
            });
            socket.on('error', () => {
              socket.destroy();
            });
            socket.on('close', () => {
              resolve({ host, alive, time: alive ? 'OK' : 'FAIL' });
            });

            socket.connect(445, host);
          });
        })
      );
      res.json(results);
    } catch (e) { 
      console.error('Erro no check de rede:', e);
      res.status(500).json({ error: 'Falha na verificação de rede' }); 
    }
  });

  // --- Scripts Management ---
  const SCRIPTS_DIR = path.join(process.cwd(), 'scripts');
  if (!fs.existsSync(SCRIPTS_DIR)) {
    fs.mkdirSync(SCRIPTS_DIR);
  }

  app.get('/api/scripts', (req, res) => {
    try {
      const files = fs.readdirSync(SCRIPTS_DIR).filter(f => f.endsWith('.bat'));
      res.json({ scripts: files });
    } catch (err) {
      res.status(500).json({ error: 'Erro ao listar scripts' });
    }
  });

  app.post('/api/scripts/upload', express.text({ limit: '1mb' }), (req, res) => {
    const { name } = req.query;
    if (!name || typeof name !== 'string' || !name.endsWith('.bat')) {
      return res.status(400).json({ error: 'Nome de arquivo inválido. Deve ser .bat' });
    }
    try {
      fs.writeFileSync(path.join(SCRIPTS_DIR, name), req.body);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: 'Erro ao salvar script' });
    }
  });

  app.delete('/api/scripts/:name', (req, res) => {
    try {
      const filePath = path.join(SCRIPTS_DIR, req.params.name);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        res.json({ success: true });
      } else {
        res.status(404).json({ error: 'Arquivo não encontrado' });
      }
    } catch (err) {
      res.status(500).json({ error: 'Erro ao deletar script' });
    }
  });

  app.post('/api/exec-script', async (req, res) => {
    const { host, scriptName } = req.body;
    const db = await readDb();
    const creds = db.credentials;
    
    if (!creds || !creds.username || !creds.password) {
      return res.status(400).json({ error: 'Credenciais não configuradas' });
    }

    const scriptPath = path.join(SCRIPTS_DIR, scriptName);
    if (!fs.existsSync(scriptPath)) {
      return res.status(404).json({ error: 'Script não encontrado no servidor' });
    }

    try {
      const { username, password } = creds;
      const result = await execWin({
        host,
        username,
        password,
        isScript: true,
        scriptPath
      });
      
      const output = cleanOutput(result.stdout + result.stderr);
      res.json({ output: output || 'Script executado com sucesso.' });
    } catch (err: any) {
      res.status(500).json({ error: cleanOutput(err.message || 'Erro ao executar script') });
    }
  });

  app.post('/api/shell', async (req, res) => {
    const { host, command } = req.body;
    const db = await readDb();
    const creds = db.credentials;

    if (!creds || !creds.username || !creds.password) {
      return res.status(400).json({ error: 'Credenciais globais não configuradas' });
    }

    try {
      const result = await execWin({
        host,
        command,
        username: creds.username,
        password: creds.password
      });

      const rawOutput = result.stdout + result.stderr;
      const output = cleanOutput(rawOutput) || 'Comando executado.';

      res.json({ output });
    } catch (err: any) {
      res.status(500).json({ error: cleanOutput(err.message || 'Erro na conexão PsExec') });
    }
  });

  app.post('/api/exec', async (req, res) => {
    const { hosts, command, username, password } = req.body;
    if (!hosts || !command) return res.status(400).json({ error: 'Dados incompletos' });
    
    try {
      const results = await Promise.all(hosts.map(async (host: string) => {
        try {
          const result = await execWin({
            host,
            command,
            username,
            password
          });
          
          const rawOutput = result.stdout + result.stderr;
          const cleaned = cleanOutput(rawOutput);
          
          return { host, status: 'success', output: cleaned || 'Executado com sucesso.' };
        } catch (err: any) {
          return { 
            host, 
            status: 'failed', 
            output: `Erro de execução:\n${cleanOutput(err.message || 'Falha no processo')}`
          };
        }
      }));
      res.json({ results });
    } catch (err) {
      console.error('Erro na API de exec:', err);
      res.status(500).json({ error: 'Erro interno no servidor' });
    }
  });

  // Helper para limpar logs de header de ferramentas como PsExec
  function cleanOutput(raw: string): string {
    return raw.split('\n').filter(line => {
      const l = line.trim();
      if (!l) return false;
      if (l.includes('PsExec v')) return false;
      if (l.includes('Sysinternals - www.sysinternals.com')) return false;
      if (l.includes('Copyright (C)')) return false;
      if (l.includes('Starting PsExec service on')) return false;
      if (l.includes('Connecting with Sysinternals Svc on')) return false;
      
      // Prompt removal
      if (/^[a-zA-Z]:\\.*>/.test(l)) return false;
      return true;
    }).join('\n').trim();
  }

  // Vite integration
  if (process.env.NODE_ENV !== 'production') {
    console.log('Iniciando middleware do Vite...');
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
    console.log(`>>> Servidor PC_MANAGER rodando em http://0.0.0.0:${port}`);
  });
}

startServer().catch((err) => {
  console.error('ERRO CRÍTICO AO INICIAR SERVIDOR:', err);
});
