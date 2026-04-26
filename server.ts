import net from 'net';
import express from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import { fileURLToPath } from 'url';
import { exec } from 'child_process';
import iconv from 'iconv-lite';

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

// Helper para execução de comandos retornando buffers brutos para depuração
async function execWin(cmd: string, timeout = 60000): Promise<{ stdout: Buffer, stderr: Buffer }> {
  return new Promise((resolve, reject) => {
    exec(cmd, { encoding: 'buffer', timeout, maxBuffer: 1024 * 1024 * 10 }, (error: any, stdout, stderr) => {
      if (error) {
        const errObj = error as any;
        errObj.stdoutRaw = stdout;
        errObj.stderrRaw = stderr;
        return reject(errObj);
      }
      resolve({ stdout: stdout as Buffer, stderr: stderr as Buffer });
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
      
      // Preservamos o máximo possível usando decoding cp850 que é o padrão Windows BR
      const outStr = iconv.decode(stdout, 'cp850');
      const errStr = iconv.decode(stderr, 'cp850');
      
      const combined = [outStr, errStr].filter(Boolean).join('\n');
      res.json({ output: cleanOutput(combined) || 'Script executado.' });
    } catch (err: any) {
      const outErr = err.stdoutRaw ? iconv.decode(err.stdoutRaw, 'cp850') : '';
      const errErr = err.stderrRaw ? iconv.decode(err.stderrRaw, 'cp850') : '';
      const msgErr = err.message || '';
      const combined = [outErr, errErr, msgErr].filter(Boolean).join('\n');
      res.status(500).json({ error: cleanOutput(combined) });
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
    const creds = db.credentials;
    
    if (!creds || !creds.username || !creds.password) {
      return res.status(400).json({ error: 'Credenciais nao configuradas.' });
    }

    const { username, password } = creds;

    try {
      // Use -nobanner to reduce noise, -h for elevation
      const escapedCommand = command.replace(/"/g, '""');
      const fullCmd = `psexec -nobanner -accepteula \\\\${host} -u "${username}" -p "${password}" -h cmd /c "${escapedCommand}"`;
      
      console.log(`[SHELL_REMOTO] ${fullCmd}`);

      const { stdout, stderr } = await execWin(fullCmd, 60000);
      
      const outStr = iconv.decode(stdout, 'cp850');
      const errStr = iconv.decode(stderr, 'cp850');
      
      // Separate actual output from PsExec messages
      let displayResult = '';
      if (outStr.trim()) {
        displayResult = outStr;
        // If we have real output and also some connection log, append log at bottom
        if (errStr.trim()) {
          displayResult += '\n\n--- [LOGS DE CONEXÃO/DEBUG] ---\n' + errStr;
        }
      } else {
        // If no stdout, show whatever we have in stderr
        displayResult = errStr;
      }

      res.json({ output: cleanOutput(displayResult) || 'Executado (Sem retorno de texto).' });
    } catch (err: any) {
      const outErr = err.stdoutRaw ? iconv.decode(err.stdoutRaw, 'cp850') : '';
      const errErr = err.stderrRaw ? iconv.decode(err.stderrRaw, 'cp850') : '';
      const msgErr = err.message || '';
      res.status(500).json({ error: cleanOutput(outErr + errErr + msgErr) });
    }
  });

  app.post('/api/exec', async (req, res) => {
    const { hosts, command, username: bodyUsername, password: bodyPassword } = req.body;
    const db = await readDb();
    const username = bodyUsername || db.credentials?.username;
    const password = bodyPassword || db.credentials?.password;

    if (!hosts || !Array.isArray(hosts) || !command) {
      return res.status(400).json({ error: 'Dados incompletos' });
    }

    try {
      const results = await Promise.all(hosts.map(async (host: string) => {
        try {
          if (username && password && host !== 'localhost' && host !== '127.0.0.1') {
            const escapedCommand = command.replace(/"/g, '""');
            const fullCmd = `psexec -nobanner -accepteula \\\\${host} -u "${username}" -p "${password}" -h cmd /c "${escapedCommand}"`;
            
            console.log(`[BULK_EXEC] ${fullCmd}`);

            const { stdout, stderr } = await execWin(fullCmd, 60000);
            
            const outStr = iconv.decode(stdout, 'cp850');
            const errStr = iconv.decode(stderr, 'cp850');
            
            let displayResult = outStr.trim() ? outStr : errStr;
            const cleaned = cleanOutput(displayResult);
            
            return { host, status: 'success', output: cleaned || 'Executado.' };
          } else {
            const { stdout, stderr } = await execWin(command);
            const combined = iconv.decode(stdout, 'cp850') + iconv.decode(stderr, 'cp850');
            return { host, status: 'success', output: cleanOutput(combined) };
          }
        } catch (err: any) {
          const outErr = err.stdoutRaw ? iconv.decode(err.stdoutRaw, 'cp850') : '';
          const errErr = err.stderrRaw ? iconv.decode(err.stderrRaw, 'cp850') : '';
          const combined = outErr + errErr + (err.message || '');
          const cleaned = cleanOutput(combined);
          return { host, status: 'failed', output: cleaned || 'Erro na execucao' };
        }
      }));
      res.json({ results });
    } catch (err) {
      console.error('Erro na API de execute:', err);
      res.status(500).json({ error: 'Erro interno no servidor' });
    }
  });

  // Helper para retornar o output o mais fiel possível ao CMD original
  function cleanOutput(raw: string): string {
    if (!raw) return '';
    // Preserve characters but normalize line endings. Remove null bytes.
    // PsExec often produces \r\r\n, so we normalize to single \n
    return raw
      .replace(/\0/g, '')
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .replace(/\n\n+/g, '\n\n') // Prevent excessive empty lines
      .trim();
  }

  // Debug log endpoint
  app.post('/api/save-debug', async (req, res) => {
    try {
      const { content } = req.body;
      await fsp.writeFile('last_output_raw.txt', content);
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: 'Erro ao salvar debug' });
    }
  });

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
