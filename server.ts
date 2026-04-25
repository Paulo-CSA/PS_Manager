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
import iconv from 'iconv-lite';

// Helper customizado para lidar com encoding CP850 (Windows)
async function execWin(cmd: string, timeout = 60000): Promise<{ stdout: string, stderr: string }> {
  return new Promise((resolve, reject) => {
    exec(cmd, { encoding: 'buffer', timeout, maxBuffer: 2 * 1024 * 1024 }, (error: any, stdout, stderr) => {
      // Usamos CP850 para suportar acentos do CMD brasileiro
      const outStr = iconv.decode(stdout as Buffer, 'cp850');
      const errStr = iconv.decode(stderr as Buffer, 'cp850');
      
      if (error) {
        error.stdout = outStr;
        error.stderr = errStr;
        return reject(error);
      }
      resolve({ stdout: outStr, stderr: errStr });
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

    // Criamos uma cópia temporária do script para injetar o comando de autodeleção
    const tempScriptName = `tmp_${Date.now()}_${scriptName}`;
    const tempScriptPath = path.join(SCRIPTS_DIR, tempScriptName);

    try {
      const { username, password } = creds;
      
      // Lemos o conteúdo original e injetamos o comando de auto-exclusão do Windows Batch
      // O comando (goto) 2>nul & del "%~f0" é um truque clássico para um .bat se deletar
      const originalContent = fs.readFileSync(scriptPath, 'utf-8');
      const modifiedContent = originalContent + '\r\n\r\nREM Auto-cleanup\r\n(goto) 2>nul & del "%~f0"\r\n';
      fs.writeFileSync(tempScriptPath, modifiedContent);

      // No Windows nativo, psexec -c lida com o upload e execução em um passo só
      // Adicionamos -f para forçar o backup/copy se já existir
      const runCmd = `psexec \\\\${host} -u ${username} -p ${password} -accepteula -f -c "${tempScriptPath}"`;
      
      console.log(`[SCRIPT_EXEC_WIN] ${runCmd}`);
      const { stdout, stderr } = await execWin(runCmd, 120000);
      
      const rawOutput = [stdout, stderr].filter(Boolean).join('\n');
      const output = cleanOutput(rawOutput);
      res.json({ output: output || 'Script executado com sucesso.' });
    } catch (err: any) {
      const rawError = [err.stdout, err.stderr, err.message].filter(Boolean).join('\n');
      const cleaned = cleanOutput(rawError);
      res.status(500).json({ error: cleaned || 'Erro ao executar script' });
    } finally {
      // Cleanup do arquivo temporário no servidor
      try {
        if (fs.existsSync(tempScriptPath)) {
          fs.unlinkSync(tempScriptPath);
        }
      } catch (cleanupErr) {
        console.error('Erro ao limpar script temporário local:', cleanupErr);
      }
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
      if (command.toLowerCase().includes('powershell')) {
          // Para powershell, evitamos o cmd /c se possível para não quebrar pipes
          fullCmd = `psexec \\\\${host} -u ${username} -p ${password} -accepteula ${command}`;
      } else {
          // No Windows, envolvemos o comando em aspas para o CMD
          const escapedCommand = command.replace(/"/g, '""');
          fullCmd = `psexec \\\\${host} -u ${username} -p ${password} -accepteula cmd /c "${escapedCommand}"`;
      }
      
      console.log(`[SHELL_WIN] ${fullCmd}`);

      const { stdout, stderr } = await execWin(fullCmd, 45000);
      const rawOutput = [stdout, stderr].filter(Boolean).join('\n');
      const output = cleanOutput(rawOutput) || 'Comando executado com sucesso (sem retorno).';

      res.json({ output });
    } catch (err: any) {
      const rawError = [err.stdout, err.stderr, err.message].filter(Boolean).join('\n');
      const cleaned = cleanOutput(rawError);
      res.status(500).json({ error: cleaned || 'Erro na conexão PsExec' });
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
            if (command.toLowerCase().includes('powershell')) {
                fullCmd = `psexec \\\\${host} -u ${username} -p ${password} -accepteula ${command}`;
            } else {
                const escapedCommand = command.replace(/"/g, '""');
                fullCmd = `psexec \\\\${host} -u ${username} -p ${password} -accepteula cmd /c "${escapedCommand}"`;
            }
            
            console.log(`[EXEC_WIN] ${fullCmd}`);

            const { stdout, stderr } = await execWin(fullCmd, 60000);
            const rawOutput = [stdout, stderr].filter(Boolean).join('\n');
            const cleaned = cleanOutput(rawOutput);
            
            return { host, status: 'success', output: cleaned || 'Executado com sucesso.' };
          } else {
            // Local fallback
            const { stdout, stderr } = await execWin(command);
            return { host, status: 'success', output: [stdout, stderr].filter(Boolean).join('\n') };
          }
        } catch (err: any) {
          const rawError = [err.stdout, err.stderr, err.message].filter(Boolean).join('\n');
          const cleaned = cleanOutput(rawError);
          return { 
            host, 
            status: 'failed', 
            output: cleaned || 'Erro desconhecido durante execução remota'
          };
        }
      }));
      res.json({ results });
    } catch (err) {
      console.error('Erro na API de exec:', err);
      res.status(500).json({ error: 'Erro interno no servidor' });
    }
  });

  // Helper para retornar o output o mais fiel possível ao CMD original
  function cleanOutput(raw: string): string {
    if (!raw) return '';
    
    // Remove apenas caracteres nulos (\0) e normaliza quebras de linha
    // Não tentamos separar ou filtrar palavras para não corromper o retorno do comando
    return raw.replace(/\0/g, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
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
