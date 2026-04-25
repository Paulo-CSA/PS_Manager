import express from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import { fileURLToPath } from 'url';
import ping from 'ping';
import bodyParser from 'body-parser';
import cors from 'cors';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const app = express();
  const port = 3000;

  app.use(cors());
  app.use(bodyParser.json());

  // API Endpoints
  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok' });
  });

  // Ping endpoint
  app.post('/api/ping', async (req, res) => {
    const { hosts } = req.body;
    if (!Array.isArray(hosts)) {
      return res.status(400).json({ error: 'Hosts must be an array' });
    }

    try {
      const results = await Promise.all(
        hosts.map(async (host) => {
          const resPing = await ping.promise.probe(host, {
            timeout: 2,
            extra: ['-c', '1'],
          });
          return {
            host,
            alive: resPing.alive,
            time: resPing.time,
          };
        })
      );
      res.json(results);
    } catch (error) {
      res.status(500).json({ error: 'Ping failed' });
    }
  });

  // Mock PsExec endpoint
  app.post('/api/exec', async (req, res) => {
    const { hosts, command, username, password } = req.body;
    
    if (!hosts || !command || !username || !password) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    console.log(`Executing command "${command}" on hosts: ${hosts.join(', ')} as ${username}`);

    // In a real environment, you would use something like impacket-psexec or a Windows-based worker.
    // Since we are in a Linux container, we will simulate the execution.
    const results = hosts.map((host: string) => {
      // Simulate some failures for variety
      const success = Math.random() > 0.1; 
      let output = success 
        ? `[${host}] Command "${command}" executed successfully.\nOutput: OK` 
        : `[${host}] Error: Access denied or timeout.`;

      // Special handling for simulated list apps
      if (command.includes('product get name') && success) {
        output = `[${host}] Microsoft Office 2021\nGoogle Chrome\nVisual Studio Code\nAdobe Acrobat Reader\nAnyDesk\nZoom`;
      }

      return {
        host,
        status: success ? 'success' : 'failed',
        output,
      };
    });

    // Artificially slow it down to feel real
    setTimeout(() => {
      res.json({ results });
    }, 1500);
  });

  // Vite integration
  const vite = await createViteServer({
    server: { middlewareMode: true },
    appType: 'spa',
  });

  app.use(vite.middlewares);

  app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
  });
}

startServer().catch(console.error);
