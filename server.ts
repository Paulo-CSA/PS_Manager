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
      
      // 1. Garantir que o diretório C:\PCManager existe via wmiexec
      const mkdirCmd = `/root/.local/bin/wmiexec.py "${username}:${password}@${host}" "if not exist C:\\PCManager mkdir C:\\PCManager"`;
      await execAsync(mkdirCmd, { timeout: 15000 }).catch(() => {}); 

      // 2. Upload do arquivo via smbclient.py para C:\PCManager\
      const smbclientPath = '/root/.local/bin/smbclient.py';
      const uploadCmd = `${smbclientPath} "${username}:${password}@${host}" -c "use C$; cd PCManager; put ${scriptPath}; exit"`;
      console.log(`[SCRIPT_UPLOAD] ${uploadCmd}`);
      await execAsync(uploadCmd, { timeout: 30000 });

      // 3. Executar o script via wmiexec
      const wmiPath = '/root/.local/bin/wmiexec.py';
      const runCmd = `${wmiPath} "${username}:${password}@${host}" "C:\\PCManager\\${scriptName}"`;
      
      console.log(`[SCRIPT_EXEC] ${runCmd}`);
      const { stdout, stderr } = await execAsync(runCmd, { timeout: 120000 });
      
      const output = cleanImpacketOutput(stdout + stderr);
      res.json({ output: output || 'Script executado com sucesso e salvo em C:\\PCManager.' });
    } catch (err: any) {
      const rawError = (err.stdout || '') + (err.stderr || err.message || '');
      res.status(500).json({ error: cleanImpacketOutput(rawError) || 'Erro ao executar script' });
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

    const wmiBase = '/root/.local/bin/wmiexec.py';

    try {
      // Usamos aspas simples ao redor do comando para evitar que o Linux interprete o '$' do PowerShell/CMD
      const shellEscapedCommand = command.replace(/'/g, "'\\''");
      const fullCmd = `${wmiBase} "${username}:${password}@${host}" '${shellEscapedCommand}'`;
      
      console.log(`[SHELL] ${fullCmd}`);

      const { stdout, stderr } = await execAsync(fullCmd, { 
        timeout: 30000,
        maxBuffer: 1024 * 512 
      });

      const rawOutput = (stdout || '') + (stderr || '');
      const output = cleanImpacketOutput(rawOutput) || 'Comando executado.';

      res.json({ output });
    } catch (err: any) {
      const rawError = (err.stdout || '') + (err.stderr || err.message || '');
      const detailedError = cleanImpacketOutput(rawError) || 'Erro na conexão WMI';
      // Mesmo com erro, se houver output útil (como resultado de um comando que retornou exit code != 0), enviamos
      res.status(500).json({ error: detailedError });
    }
  });

  app.post('/api/exec', async (req, res) => {
    const { hosts, command, username, password } = req.body;
    if (!hosts || !command) return res.status(400).json({ error: 'Dados incompletos' });
    
    try {
      const results = await Promise.all(hosts.map(async (host: string) => {
        try {
          let finalCmd = command;
          
          if (username && password && host !== 'localhost' && host !== '127.0.0.1') {
            // Prioritizing wmiexec.py as requested for better reliability
            const possibleCmds = [
              `/root/.local/bin/wmiexec.py`,
              `wmiexec.py`,
              `/root/.local/bin/psexec.py`,
              `psexec.py`,
              `impacket-psexec`,
              `/usr/local/bin/psexec.py`,
              `python3 -m impacket.examples.wmiexec`,
              `python3 -m impacket.examples.psexec`
            ];
            
            let lastError = null;
            let success = false;
            let output = '';

            for (const base of possibleCmds) {
              try {
                // Usamos aspas simples ao redor do comando para evitar que o Linux interprete o '$' do PowerShell
                const escapedCommand = command.replace(/'/g, "'\\''");
                const fullCmd = `${base} "${username}:${password}@${host}" '${escapedCommand}'`;
                
                console.log(`[EXEC] ${fullCmd}`);

                const { stdout, stderr } = await execAsync(fullCmd, { 
                  timeout: 60000,
                  maxBuffer: 1024 * 1024 
                });
                
                const rawOutput = (stdout || '') + (stderr || '');
                const cleaned = cleanImpacketOutput(rawOutput);
                
                output = cleaned || 'Executado com sucesso.';
                success = true;
                break;
              } catch (err: any) {
                lastError = err;
                
                // Se psexec retornou erro mas tem output (ou erro de pipes), tentamos ler o que veio
                const rawOutput = (err.stdout || '') + (err.stderr || '');
                const cleaned = cleanImpacketOutput(rawOutput);
                
                // Se o erro for de rede/SMB (STATUS_REQUEST_NOT_ACCEPTED), não devemos considerar sucesso
                const isSmbError = rawOutput.includes('SMB SessionError') || rawOutput.includes('STATUS_REQUEST_NOT_ACCEPTED');

                // Se temos conteúdo útil e NÃO é um erro fatal de SMB, tentamos extrair o que deu
                if (cleaned && !isSmbError && !cleaned.includes('Something wen\'t wrong connecting the pipes')) {
                   output = cleaned;
                   success = true;
                   break;
                }

                if (err.message.includes('not found')) {
                   continue;
                }
                
                console.error(`Falha ao tentar ${base}:`, err.stderr || err.message);
                // Se falhou por erro real (não "not found"), interrompe o loop e mostra o erro
                break;
              }
            }

            if (success) {
              return { host, status: 'success', output };
            } else {
              // Retorna o output detalhado para que o usuário saiba por que o psexec falhou
              const rawError = (lastError?.stdout || '') + (lastError?.stderr || lastError?.message || '');
              const detailedError = cleanImpacketOutput(rawError) || 'Erro desconhecido';
              return { 
                host, 
                status: 'failed', 
                output: `Erro de execução remota:\n${detailedError}`
              };
            }
          }
        } catch (err: any) {
          return { 
            host, 
            status: 'failed', 
            output: `Erro: ${err.stderr || err.stdout || err.message}` 
          };
        }
      }));
      res.json({ results });
    } catch (err) {
      console.error('Erro na API de exec:', err);
      res.status(500).json({ error: 'Erro interno no servidor' });
    }
  });

  // Helper para limpar logs do Impacket
  function cleanImpacketOutput(raw: string): string {
    return raw.split('\n').filter(line => {
      const l = line.trim();
      if (!l) return false;
      if (l.startsWith('Impacket v')) return false;
      if (l.startsWith('[*]')) return false;
      if (l.startsWith('[+]')) return false;
      if (l.startsWith('[-] Something wen\'t wrong')) return false;
      if (l.startsWith('[!] Press help')) return false;
      if (l.startsWith('Configuring service...')) return false;
      // WMIExec specific prompt removal (e.g., C:\> or C:\Windows\system32>)
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
