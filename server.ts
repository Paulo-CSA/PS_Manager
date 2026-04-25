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

import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

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
      
      // No Windows nativo, psexec -c lida com o upload e execução em um passo só
      // Adicionamos -f para forçar o backup/copy se já existir e -i se puder ser interativo
      const runCmd = `psexec \\\\${host} -u ${username} -p ${password} -accepteula -nobanner -f -c "${scriptPath}"`;
      
      console.log(`[SCRIPT_EXEC_WIN] ${runCmd}`);
      const { stdout, stderr } = await execAsync(runCmd, { timeout: 120000 });
      
      const rawOutput = (stdout || '') + (stderr || '');
      const output = cleanOutput(rawOutput);
      res.json({ output: output || 'Script executado com sucesso.' });
    } catch (err: any) {
      const rawError = (err.stdout || '') + (err.stderr || err.message || '');
      const cleaned = cleanOutput(rawError);
      res.status(500).json({ error: cleaned || rawError || 'Erro ao executar script' });
    }
  });

  app.post('/api/shell', async (req, res) => {
    const { host, command } = req.body;
    const db = await readDb();
    const machine = db.machines.find((m: any) => m.ip === host);

    if (!machine) {
      return res.status(404).json({ error: 'Host não encontrado na base de dados' });
    }

    const creds = db.credentials;
    if (!creds || !creds.username || !creds.password) {
      return res.status(400).json({ error: 'Credenciais globais não configuradas' });
    }

    const { username, password } = creds;

    try {
      // Determinamos a melhor forma de chamar o comando
      let fullCmd;
      const lowerCmd = command.toLowerCase().trim();
      
      // No Windows, quando o comando tem caracteres especiais como pipes (|),
      // precisamos garantir que o PsExec receba o bloco inteiro corretamente.
      // A melhor prática com PsExec para comandos complexos é envolver o comando em aspas.
      const escapedCommand = command.replace(/"/g, '""');
      
      if (lowerCmd.startsWith('powershell')) {
          // Se for powershell direto, passamos ele como o executável
          fullCmd = `psexec \\\\${host} -u ${username} -p ${password} -accepteula -nobanner ${command}`;
      } else {
          // Se for comando variado, usamos o wrap do cmd /c
          fullCmd = `psexec \\\\${host} -u ${username} -p ${password} -accepteula -nobanner cmd /c "${escapedCommand}"`;
      }
      
      console.log(`[SHELL_WIN] ${fullCmd}`);

      const { stdout, stderr } = await execAsync(fullCmd, { 
        timeout: 60000,
        maxBuffer: 1024 * 1024 // 1MB
      });

      const rawOutput = (stdout || '') + (stderr || '');
      const output = cleanOutput(rawOutput);

      res.json({ output: output || 'Comando executado com sucesso (sem retorno).' });
    } catch (err: any) {
      const rawError = (err.stdout || '') + (err.stderr || err.message || '');
      const cleaned = cleanOutput(rawError);
      res.status(500).json({ error: cleaned || rawError || 'Erro na conexão PsExec' });
    }
  });

  app.post('/api/exec', async (req, res) => {
    const { hosts, command, username, password } = req.body;
    if (!hosts || !command) return res.status(400).json({ error: 'Dados incompletos' });
    
    try {
      const results = await Promise.all(hosts.map(async (host: string) => {
        try {
          if (username && password && host !== 'localhost' && host !== '127.0.0.1') {
            let fullCmd;
            const lowerCmd = command.toLowerCase().trim();
            
            const escapedCommand = command.replace(/"/g, '""');
            
            if (lowerCmd.startsWith('powershell')) {
                fullCmd = `psexec \\\\${host} -u ${username} -p ${password} -accepteula -nobanner ${command}`;
            } else {
                fullCmd = `psexec \\\\${host} -u ${username} -p ${password} -accepteula -nobanner cmd /c "${escapedCommand}"`;
            }
            
            console.log(`[EXEC_WIN] ${fullCmd}`);

            const { stdout, stderr } = await execAsync(fullCmd, { 
              timeout: 60000,
              maxBuffer: 1024 * 1024 
            });
            
            const rawOutput = (stdout || '') + (stderr || '');
            const cleaned = cleanOutput(rawOutput);
            
            // Se o comando teve output real, usamos ele. Se foi vazio ou so tinha cabeçalho, enviamos a mensagem padrão.
            return { host, status: 'success', output: cleaned || 'Executado com sucesso (sem retorno).' };
          } else {
            // Local fallback
            const { stdout, stderr } = await execAsync(command);
            return { host, status: 'success', output: stdout + stderr };
          }
        } catch (err: any) {
          const rawError = (err.stdout || '') + (err.stderr || err.message || '');
          const cleaned = cleanOutput(rawError);
          return { 
            host, 
            status: 'failed', 
            output: cleaned || rawError || 'Erro desconhecido durante execução remota'
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
    const lines = raw.split(/\r?\n/);
    const filtered = lines.filter(line => {
      const l = line.trim();
      if (!l) return false;
      
      const lower = l.toLowerCase();
      // Filtros exatos e de prefixo para banners do PsExec
      if (lower.startsWith('psexec v')) return false;
      if (lower.startsWith('sysinternals - www.sysinternals.com')) return false;
      if (lower.startsWith('copyright (c)')) return false;
      if (lower.startsWith('starting psexec service on')) return false;
      if (lower.startsWith('connecting with psexec service on')) return false;
      if (lower.includes('psexec service on')) return false;
      if (lower.startsWith('connecting to')) return false;
      if (lower.startsWith('starting cmd on')) return false;
      if (lower.startsWith('starting powershell on')) return false;
      if (lower.startsWith('copying authentication key to')) return false;
      
      // Filtra mensagens de progresso/finalização que poluem o output
      if (lower.includes('exited on') && lower.includes('with error code')) return false;
      if (lower.includes('cmd exited on')) return false;
      if (lower.includes('powershell exited on')) return false;
      
      // Prompt removal (e.g., C:\> or C:\Windows\system32>)
      if (/^[a-zA-Z]:\\.*>/.test(l)) return false;
      
      return true;
    });

    return filtered.join('\n').trim();
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
