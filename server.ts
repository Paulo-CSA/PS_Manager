import net from 'net';
import express from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import { fileURLToPath } from 'url';

import bodyParser from 'body-parser';
import cors from 'cors';
import fs from 'fs/promises';
import { existsSync, mkdirSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, 'server_storage');
const DATA_FILE = path.join(DATA_DIR, 'persistence.json');

// Ensure data directory exists
if (!existsSync(DATA_DIR)) {
  mkdirSync(DATA_DIR);
  console.log(`>>> Criado diretório de persistência em: ${DATA_DIR}`);
}

// Helper to read/write JSON database
async function readDb() {
  try {
    const data = await fs.readFile(DATA_FILE, 'utf-8');
    return JSON.parse(data);
  } catch (e) {
    return { machines: [], credentials: {} };
  }
}

async function writeDb(data: any) {
  await fs.writeFile(DATA_FILE, JSON.stringify(data, null, 2));
}

import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

async function startServer() {
  const app = express();
  const port = 3000;

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

  app.post('/api/exec', async (req, res) => {
    const { hosts, command, username, password } = req.body;
    if (!hosts || !command) return res.status(400).json({ error: 'Dados incompletos' });
    
    try {
      const results = await Promise.all(hosts.map(async (host: string) => {
        try {
          let finalCmd = command;
          
          if (username && password && host !== 'localhost' && host !== '127.0.0.1') {
            // Tenta psexec.py, impacket-psexec ou via python3 -m
            // Para maior robustez, tentamos localizar o comando
            const possibleCmds = [
              `/root/.local/bin/psexec.py`,
              `psexec.py`,
              `impacket-psexec`,
              `/usr/local/bin/psexec.py`,
              `python3 -m impacket.examples.psexec`
            ];
            
            let lastError = null;
            let success = false;
            let output = '';

            for (const base of possibleCmds) {
              try {
                // O psexec.py as vezes prefere '/' em vez de '\' para domínio/usuário no Linux
                // E precisamos garantir que as aspas não quebrem o shell
                const safeCreds = `${username}:${password}@${host}`;
                const safeCommand = command.replace(/"/g, '\\"');
                const fullCmd = `${base} "${safeCreds}" "${safeCommand}"`;
                
                console.log(`[DEBUG] Tentando: ${fullCmd}`);

                const { stdout, stderr } = await execAsync(fullCmd, { 
                  timeout: 60000,
                  maxBuffer: 1024 * 1024 
                });
                
                output = stdout || stderr || 'Executado com sucesso.';
                success = true;
                break;
              } catch (err: any) {
                lastError = err;
                console.error(`Falha ao tentar ${base}:`, err.stderr || err.message);
                
                if (err.message.includes('not found')) {
                   continue;
                }
                break;
              }
            }

            if (success) {
              return { host, status: 'success', output };
            } else {
              // Retorna o stderr detalhado para que o usuário saiba por que o psexec falhou
              const detailedError = lastError?.stderr || lastError?.message || 'Erro desconhecido';
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

  // Vite integration
  console.log('Iniciando middleware do Vite...');
  const vite = await createViteServer({
    server: { 
      middlewareMode: true
    },
    appType: 'spa',
  });

  app.use(vite.middlewares);

  app.listen(port, '0.0.0.0', () => {
    console.log(`>>> Servidor PS_MANAGER rodando em http://0.0.0.0:${port}`);
  });
}

startServer().catch((err) => {
  console.error('ERRO CRÍTICO AO INICIAR SERVIDOR:', err);
});
