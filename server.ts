import express from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import { fileURLToPath } from 'url';
import ping from 'ping';
import bodyParser from 'body-parser';
import cors from 'cors';
import fs from 'fs/promises';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_FILE = path.join(__dirname, 'data.json');

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

  // --- 기존 API ---
  app.post('/api/ping', async (req, res) => {
    const { hosts } = req.body;
    if (!Array.isArray(hosts)) return res.status(400).json({ error: 'Hosts em formato inválido' });
    try {
      const results = await Promise.all(
        hosts.map(async (host) => {
          const resPing = await ping.promise.probe(host, { timeout: 2, extra: ['-c', '1'] });
          return { host, alive: resPing.alive, time: resPing.time };
        })
      );
      res.json(results);
    } catch (e) { res.status(500).json({ error: 'Falha no ping' }); }
  });

  app.post('/api/exec', async (req, res) => {
    const { hosts, command, username, password } = req.body;
    if (!hosts || !command || !username || !password) return res.status(400).json({ error: 'Dados incompletos' });
    const results = hosts.map((host: string) => {
      const success = Math.random() > 0.1;
      let output = success ? `[${host}] Comando "${command}" executado.\nOutput: OK` : `[${host}] Erro: Tempo esgotado.`;
      if (command.includes('product get name') && success) {
        output = `[${host}] Microsoft Office\nGoogle Chrome\nVisual Studio Code\nAdobe Acrobat\nAnyDesk\nZoom`;
      }
      return { host, status: success ? 'success' : 'failed', output };
    });
    setTimeout(() => res.json({ results }), 1000);
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
