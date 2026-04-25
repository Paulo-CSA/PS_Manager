import React, { useState, useEffect, useRef } from 'react';
import { 
  Monitor, Settings, Plus, Trash2, Play, Activity, 
  Shield, Terminal, Cpu, CheckCircle, XCircle, RefreshCw,
  LogOut, ChevronRight, Globe, Lock, Key, ScrollText, FileCode, UploadCloud, Trash
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

// --- Types ---
interface Machine {
  id: string;
  name: string;
  ip: string;
  status: 'online' | 'offline' | 'unknown';
  lastPing?: string;
  ownerId: string;
}

interface Credentials {
  username?: string;
  password?: string;
}

// --- App Component ---

const App = () => {
  // Use a stable dummy user ID for local storage (legacy ref, keeping for stability)
  const [user] = useState({ uid: 'ps-manager-local-user' });
  const [loading, setLoading] = useState(true);
  const [machines, setMachines] = useState<Machine[]>([]);
  const [selectedHosts, setSelectedHosts] = useState<string[]>([]);
  const [creds, setCreds] = useState<Credentials>({ username: '', password: '' });
  const [log, setLog] = useState<string[]>([]);
  const [activeTab, setActiveTab] = useState<'dashboard' | 'config'>('dashboard');
  
  const [statusFilter, setStatusFilter] = useState<'all' | 'online'>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [currentPage, setCurrentPage] = useState(1);
  const itemsPerPage = 10;
  
  // Modals
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [isExecModalOpen, setIsExecModalOpen] = useState(false);
  const [execResult, setExecResult] = useState<{host: string, status: string, output: string}[] | null>(null);
  const [execLoading, setExecLoading] = useState(false);
  const [isIPModalOpen, setIsIPModalOpen] = useState(false);
  const [isAppModalOpen, setIsAppModalOpen] = useState(false);
  const [isWaitModalOpen, setIsWaitModalOpen] = useState(false);
  const [isScriptManagerOpen, setIsScriptManagerOpen] = useState(false);
  const [isRunScriptModalOpen, setIsRunScriptModalOpen] = useState(false);
  const [scripts, setScripts] = useState<string[]>([]);
  const [scriptToRun, setScriptToRun] = useState<string | null>(null);
  const [scriptTargetHosts, setScriptTargetHosts] = useState<string[]>([]);
  const [isTerminalOpen, setIsTerminalOpen] = useState(false);
  const [terminalHost, setTerminalHost] = useState<string | null>(null);
  const [terminalLog, setTerminalLog] = useState<{ type: 'in' | 'out', text: string }[]>([]);
  const [terminalLoading, setTerminalLoading] = useState(false);
  const terminalEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isTerminalOpen) {
      terminalEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [terminalLog, isTerminalOpen]);

  const [isConsoleOpen, setIsConsoleOpen] = useState(false);
  const [consoleLog, setConsoleLog] = useState<{ type: 'system' | 'cmd' | 'result' | 'error', text: string, host?: string }[]>([]);
  const consoleLogEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isConsoleOpen) {
      consoleLogEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [consoleLog, isConsoleOpen]);

  const addConsoleEntry = (entry: { type: 'system' | 'cmd' | 'result' | 'error', text: string, host?: string }) => {
    setConsoleLog(prev => [...prev, entry]);
    setLog(prev => [...prev, `[${entry.type.toUpperCase()}] ${entry.host ? `[${entry.host}] ` : ''}${entry.text}`]);
  };

  // Forms
  const [newMachine, setNewMachine] = useState({ name: '', ip: '' });
  const [customCommand, setCustomCommand] = useState('');
  const [ipConfig, setIpConfig] = useState({ ip: '', mask: '255.255.255.0', gw: '' });
  const [installedApps, setInstalledApps] = useState<string[]>([]);
  const [tempExecHost, setTempExecHost] = useState<string[] | null>(null);
  
  // Guard to prevent initial save loop
  const isInitialized = useRef(false);

  // Load data from Server
  useEffect(() => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    fetch('/api/data', { signal: controller.signal })
      .then(res => res.json())
      .then(db => {
        clearTimeout(timeoutId);
        if (db.machines) setMachines(db.machines);
        if (db.credentials) setCreds(db.credentials);
        setLoading(false);
      })
      .catch(err => {
        clearTimeout(timeoutId);
        console.error('Falha ao carregar dados do servidor', err);
        setLog(prev => [...prev, '[SYSTEM] Erro ao conectar ao servidor. Usando cache local.']);
        setLoading(false);
      });
  }, []);

  const fetchScripts = async () => {
    try {
      const res = await fetch('/api/scripts');
      const data = await res.json();
      if (data.scripts) setScripts(data.scripts);
    } catch (err) {
      console.error('Erro ao buscar scripts');
    }
  };

  useEffect(() => {
    fetchScripts();
  }, []);

  const uploadScript = async (name: string, content: string) => {
    if (!name.endsWith('.bat')) name += '.bat';
    try {
      const res = await fetch(`/api/scripts/upload?name=${name}`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: content
      });
      if (res.ok) {
        setLog(prev => [...prev, `[SCRIPT] Script ${name} enviado com sucesso.`]);
        fetchScripts();
      }
    } catch (err) {
      setLog(prev => [...prev, `[ERROR] Erro ao enviar script.`]);
    }
  };

  const deleteScript = async (name: string) => {
    try {
      const res = await fetch(`/api/scripts/${name}`, { method: 'DELETE' });
      if (res.ok) {
        setLog(prev => [...prev, `[SCRIPT] Script ${name} removido.`]);
        fetchScripts();
      }
    } catch (err) {
      setLog(prev => [...prev, `[ERROR] Erro ao deletar script.`]);
    }
  };

  const executeScriptOnHosts = async (scriptName: string, hosts: string[]) => {
    setIsRunScriptModalOpen(false);
    setIsWaitModalOpen(true);
    
    for (const host of hosts) {
      setLog(prev => [...prev, `[SCRIPT] Executando ${scriptName} em ${host}...`]);
      try {
        const res = await fetch('/api/exec-script', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ host, scriptName })
        });
        const data = await res.json();
        if (res.ok) {
          setLog(prev => [...prev, `[${host}] SUCESSO: ${data.output}`]);
        } else {
          setLog(prev => [...prev, `[${host}] FALHA: ${data.error}`]);
        }
      } catch (err) {
        setLog(prev => [...prev, `[${host}] ERRO DE REDE.`]);
      }
    }
    setIsWaitModalOpen(false);
  };

  // Save machines to Server whenever they change
  useEffect(() => {
    if (loading || !isInitialized.current) {
      if (!loading) isInitialized.current = true;
      return;
    }
    
    const timeoutId = setTimeout(() => {
      fetch('/api/machines', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ machines })
      });
    }, 500); // Small debounce

    return () => clearTimeout(timeoutId);
  }, [machines, loading]);

  // Save credentials to Server whenever they change
  useEffect(() => {
    if (loading || !isInitialized.current) return;
    
    const timeoutId = setTimeout(() => {
      fetch('/api/credentials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ credentials: creds })
      });
    }, 500); // Small debounce

    return () => clearTimeout(timeoutId);
  }, [creds, loading]);

  const handleCsvUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      const text = event.target?.result as string;
      const lines = text.split('\n');
      const batch: Machine[] = [];

      lines.forEach(line => {
        const [name, ip] = line.split(',').map(s => s.trim());
        if (name && ip) {
          const mId = (typeof window !== 'undefined' && window.crypto && typeof window.crypto.randomUUID === 'function')
            ? window.crypto.randomUUID() 
            : Math.random().toString(36).substring(2, 11);

          batch.push({
            id: mId,
            name,
            ip,
            status: 'unknown',
            ownerId: user.uid
          });
        }
      });

      if (batch.length > 0) {
        setLog(prev => [...prev, `[CSV] Importando ${batch.length} máquinas...`]);
        setMachines(prev => [...prev, ...batch]);
        setLog(prev => [...prev, `[CSV] Importação concluída.`]);
        setIsAddModalOpen(false);
      }
    };
    reader.readAsText(file);
  };

  const addMachine = (e: React.FormEvent) => {
    e.preventDefault();
    try {
      if (!newMachine.name || !newMachine.ip) return;
      
      const machineId = (typeof window !== 'undefined' && window.crypto && typeof window.crypto.randomUUID === 'function')
        ? window.crypto.randomUUID() 
        : Math.random().toString(36).substring(2, 11);

      const machine: Machine = {
        id: machineId,
        name: newMachine.name,
        ip: newMachine.ip,
        status: 'unknown',
        ownerId: user.uid
      };

      setMachines(prev => [...prev, machine]);
      setLog(prev => [...prev, `[SYSTEM] Máquina ${machine.name} (${machine.ip}) cadastrada com sucesso.`]);
      setNewMachine({ name: '', ip: '' });
      setIsAddModalOpen(false);
    } catch (err) {
      console.error('Erro ao adicionar máquina:', err);
      setLog(prev => [...prev, `[ERROR] Falha ao cadastrar máquina.`]);
    }
  };

  const deleteMachine = (id: string) => {
    setMachines(prev => prev.filter(m => m.id !== id));
    setSelectedHosts(prev => prev.filter(h => h !== machines.find(m => m.id === id)?.ip));
  };

  const saveCreds = () => {
    // Already saved via useEffect
    setLog(prev => [...prev, `[SYSTEM] Credenciais salvas localmente.`]);
  };

  const runPing = async () => {
    if (machines.length === 0) return;
    const hosts = machines.map(m => m.ip);
    setLog(prev => [...prev, `[SYSTEM] Verificando conectividade via porta 445 (SMB) em ${hosts.length} hosts...`]);
    addConsoleEntry({ type: 'system', text: `Iniciando verificação de rede em ${hosts.length} máquinas...` });
    
    try {
      const res = await fetch('/api/ping', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hosts })
      });
      const results = await res.json();
      
      results.forEach((r: any) => {
        const icon = r.alive ? '✅' : '❌';
        setLog(prev => [...prev, `[PING] ${r.host} está ${r.alive ? 'ONLINE' : 'OFFLINE'} ${icon}`]);
        addConsoleEntry({ type: 'result', host: r.host, text: `Status: ${r.alive ? 'ONLINE' : 'OFFLINE'}` });
      });

      setMachines(prev => prev.map(m => {
        const r = results.find((res: any) => res.host === m.ip);
        if (r) {
          return { ...m, status: r.alive ? 'online' : 'offline', lastPing: new Date().toISOString() };
        }
        return m;
      }));
      setLog(prev => [...prev, `[SYSTEM] Verificação de conectividade concluída.`]);
    } catch (err) {
      setLog(prev => [...prev, `[ERROR] Falha ao realizar ping.`]);
    }
  };

  const executeRemote = async (command: string, overrideHosts?: string[]) => {
    const targets = overrideHosts || selectedHosts;
    if (targets.length === 0) {
      alert('Selecione ao menos um host.');
      return;
    }
    if (!creds.username || !creds.password) {
      alert('Configure as credenciais primeiro.');
      return;
    }

    setLog(prev => [...prev, `[CMD] Executando: "${command}" em ${targets.length} hosts...`]);
    addConsoleEntry({ type: 'cmd', text: command, host: targets.join(', ') });
    setIsConsoleOpen(true); // Open console automatically to show output
    
    try {
      const res = await fetch('/api/exec', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          hosts: targets,
          command,
          username: creds.username,
          password: creds.password
        })
      });
      const { results } = await res.json();
      
      results.forEach((r: any) => {
        setLog(prev => [...prev, `[${r.host}] ${r.status.toUpperCase()}: ${r.output}`]);
        addConsoleEntry({ 
          type: r.status === 'success' ? 'result' : 'error', 
          host: r.host, 
          text: r.output 
        });
      });
      return results;
    } catch (err) {
      setLog(prev => [...prev, `[ERROR] Falha na execução remota.`]);
      addConsoleEntry({ type: 'error', text: 'Falha crítica na comunicação com o servidor API.' });
      return null;
    }
  };

  const listApps = async () => {
    if (selectedHosts.length === 0) {
      alert('Selecione uma máquina para listar os apps.');
      return;
    }
    const host = selectedHosts[0];
    setLog(prev => [...prev, `[SYSTEM] Consultando aplicativos em ${host}...`]);
    setIsWaitModalOpen(true);
    
    // Comando reg query sugerido pelo usuário para listar aplicativos instalados
    const results = await executeRemote(`reg query HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall /s /v DisplayName & reg query HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall /s /v DisplayName`, [host]);
    setIsWaitModalOpen(false);

    if (results && results[0]) {
      const output = results[0].output || '';
      const apps = output
        .split(/\r?\n/)
        .map((line: string) => {
          const l = line.trim();
          // Formato esperado do reg query: "DisplayName    REG_SZ    Nome do App"
          // Usamos Regex para capturar tudo após REG_SZ (que pode ter múltiplos espaços)
          const match = l.match(/DisplayName\s+REG_SZ\s+(.*)/i);
          if (match && match[1]) {
            return match[1].trim();
          }
          return null;
        })
        .filter((a: string | null): a is string => 
          !!a && 
          !a.toLowerCase().includes('psexec') &&
          a.length > 1
        );
      setInstalledApps(Array.from(new Set(apps)).sort());
      setIsAppModalOpen(true);
    }
  };

  const uninstallApp = async (appName: string) => {
    if (!confirm(`Deseja realmente desinstalar "${appName}"?`)) return;
    const host = selectedHosts[0];
    // Comando via PowerShell otimizado para desinstalação verificando ambos os registros (32 e 64 bits)
    const uninstallCmd = `powershell -NoProfile -ExecutionPolicy Bypass -Command "$paths = @('HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*', 'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'); $app = Get-ItemProperty $paths | Where-Object { $_.DisplayName -eq '${appName.trim()}' } | Select-Object -First 1; if ($app.UninstallString) { $u = $app.UninstallString; if ($u -match 'MsiExec.exe') { $u = $u -replace '/I', '/X' + ' /quiet /norestart' } else { if ($u -notmatch '/quiet') { $u += ' /S /quiet /verysilent /norestart' } }; Start-Process cmd.exe -ArgumentList '/c', $u -Wait }"`;
    await executeRemote(uninstallCmd, [host]);
    setIsAppModalOpen(false);
  };

  const openTerminal = (host: string) => {
    setTerminalHost(host);
    setTerminalLog([{ type: 'out', text: `Conectando ao terminal WMI de ${host}...` }]);
    setIsTerminalOpen(true);
  };

  const sendTerminalCommand = async (command: string) => {
    if (!command.trim() || !terminalHost) return;
    
    setTerminalLog(prev => [...prev, { type: 'in', text: command }]);
    setTerminalLoading(true);
    
    try {
      const res = await fetch('/api/shell', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ host: terminalHost, command })
      });
      const data = await res.json();
      
      if (res.ok) {
        setTerminalLog(prev => [...prev, { type: 'out', text: data.output }]);
      } else {
        setTerminalLog(prev => [...prev, { type: 'out', text: `ERRO: ${data.error}` }]);
      }
    } catch (err) {
      setTerminalLog(prev => [...prev, { type: 'out', text: `ERRO DE CONEXÃO.` }]);
    } finally {
      setTerminalLoading(false);
    }
  };

  // Table Filtering and Pagination
  const filteredMachines = machines.filter(m => {
    const matchesStatus = statusFilter === 'all' || m.status === 'online';
    const matchesSearch = !searchQuery || 
      m.name.toLowerCase().includes(searchQuery.toLowerCase()) || 
      m.ip.includes(searchQuery);
    return matchesStatus && matchesSearch;
  });

  const totalPages = Math.ceil(filteredMachines.length / itemsPerPage);
  const currentMachines = filteredMachines.slice(
    (currentPage - 1) * itemsPerPage,
    currentPage * itemsPerPage
  );

  useEffect(() => {
    setCurrentPage(1);
  }, [searchQuery, statusFilter]);

  if (loading) return <div className="min-h-screen bg-[#111] flex items-center justify-center text-white font-mono">LOADING_SYSTEM...</div>;

  return (
    <div className="min-h-screen bg-[#0A0A0B] text-[#E4E3E0] font-sans selection:bg-blue-500/30">
      {/* Header */}
      <header className="border-bottom border-white/5 bg-[#111113] px-6 py-4 flex items-center justify-between sticky top-0 z-50">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-blue-600 rounded-lg flex items-center justify-center shadow-lg shadow-blue-900/20">
            <Cpu className="text-white" size={24} />
          </div>
          <div>
            <h1 className="text-lg font-bold tracking-tight leading-none">PC_MANAGER</h1>
            <span className="text-[10px] text-blue-500 font-mono uppercase tracking-[0.2em]">Remote Control v1.0</span>
          </div>
        </div>

        <div className="flex items-center gap-4">
          <nav className="flex bg-[#1A1B1E] rounded-full p-1 border border-white/5">
            <button 
              onClick={() => setActiveTab('dashboard')}
              className={`px-4 py-1.5 rounded-full text-xs font-medium transition-all ${activeTab === 'dashboard' ? 'bg-white text-black' : 'text-gray-400 hover:text-white'}`}
            >
              Dashboard
            </button>
            <button 
              onClick={() => setActiveTab('config')}
              className={`px-4 py-1.5 rounded-full text-xs font-medium transition-all ${activeTab === 'config' ? 'bg-white text-black' : 'text-gray-400 hover:text-white'}`}
            >
              Configurações
            </button>
          </nav>

          <div className="h-8 w-[1px] bg-white/10 mx-2" />

          <div className="flex items-center gap-3">
            <div className="flex flex-col text-right">
              <span className="text-[10px] text-gray-500 font-mono">MODO_LOCAL</span>
              <span className="text-xs font-mono text-blue-400">{user.uid.substring(0, 10)}</span>
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto p-6 grid grid-cols-12 gap-6">
        
        {/* Left Sidebar / Stats */}
        <div className="col-span-12 lg:col-span-3 space-y-6">
          <div className="bg-[#151619] border border-white/5 rounded-2xl p-5">
            <h3 className="text-[10px] font-mono uppercase text-gray-500 tracking-widest mb-4">Status da Rede</h3>
            <div className="space-y-4">
              <div className="flex justify-between items-center">
                <span className="text-sm text-gray-400">Total de Máquinas</span>
                <span className="text-xl font-mono">{machines.length}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-sm text-gray-400">Online</span>
                <span className="text-xl font-mono text-emerald-500">{machines.filter(m => m.status === 'online').length}</span>
              </div>
              <button 
                onClick={runPing}
                className="w-full mt-2 py-3 bg-white/5 hover:bg-white/10 border border-white/10 rounded-xl text-sm font-medium flex items-center justify-center gap-2 transition-all"
              >
                <RefreshCw size={16} /> Atualizar Status
              </button>
            </div>
          </div>

          <div className="bg-[#151619] border border-white/5 rounded-2xl p-5 overflow-hidden">
            <h3 className="text-[10px] font-mono uppercase text-gray-500 tracking-widest mb-4">Ações Rápidas</h3>
            <div className="grid grid-cols-1 gap-2">
              <button 
                onClick={() => setIsScriptManagerOpen(true)}
                className="p-3 bg-[#1A1B1E] hover:bg-blue-600 hover:text-white border border-white/5 rounded-xl text-left text-xs transition-all group flex items-center justify-between"
              >
                <div className="flex items-center gap-2">
                  <ScrollText size={14} className="text-blue-500 group-hover:text-white" />
                  <span>Gerenciar Scripts</span>
                </div>
                <ChevronRight size={14} className="opacity-0 group-hover:opacity-100 transition-opacity" />
              </button>
              <button 
                onClick={() => executeRemote('gpupdate /force')}
                className="p-3 bg-[#1A1B1E] hover:bg-blue-600 hover:text-white border border-white/5 rounded-xl text-left text-xs transition-all group flex items-center justify-between"
              >
                <span>Forçar GPUpdate</span>
                <ChevronRight size={14} className="opacity-0 group-hover:opacity-100 transition-opacity" />
              </button>
              <button 
                onClick={() => executeRemote('gpresult /r')}
                className="p-3 bg-[#1A1B1E] hover:bg-blue-600 hover:text-white border border-white/5 rounded-xl text-left text-xs transition-all group flex items-center justify-between"
              >
                <span>Obter GPResult /r</span>
                <ChevronRight size={14} className="opacity-0 group-hover:opacity-100 transition-opacity" />
              </button>
              <button 
                onClick={() => listApps()}
                className="p-3 bg-[#1A1B1E] hover:bg-blue-600 hover:text-white border border-white/5 rounded-xl text-left text-xs transition-all group flex items-center justify-between"
              >
                <span>Gerenciar Aplicativos</span>
                <ChevronRight size={14} className="opacity-0 group-hover:opacity-100 transition-opacity" />
              </button>
              <button 
                onClick={() => setIsIPModalOpen(true)}
                className="p-3 bg-[#1A1B1E] hover:bg-blue-600 hover:text-white border border-white/5 rounded-xl text-left text-xs transition-all group flex items-center justify-between"
              >
                <span>Configurar Endereço IP</span>
                <ChevronRight size={14} className="opacity-0 group-hover:opacity-100 transition-opacity" />
              </button>
              <div className="grid grid-cols-2 gap-2 mt-2">
                <button 
                  onClick={() => confirm('Reiniciar máquinas selecionadas?') && executeRemote('shutdown /r /t 0')}
                  className="p-3 bg-amber-600/10 text-amber-500 border border-amber-600/20 rounded-xl text-left text-xs font-bold hover:bg-amber-600 hover:text-white transition-all"
                >
                  Reiniciar
                </button>
                <button 
                  onClick={() => confirm('Desligar máquinas selecionadas?') && executeRemote('shutdown /s /t 0')}
                  className="p-3 bg-red-600/10 text-red-500 border border-red-600/20 rounded-xl text-left text-xs font-bold hover:bg-red-600 hover:text-white transition-all"
                >
                  Desligar
                </button>
              </div>
              <button 
                onClick={() => setIsExecModalOpen(true)}
                className="p-3 bg-blue-600 text-white rounded-xl text-left text-xs font-bold mt-2 hover:bg-blue-700 transition-all shadow-lg shadow-blue-600/20"
              >
                Comando Customizado (CMD)
              </button>
            </div>
          </div>
        </div>

        {/* Center / List */}
        <div className="col-span-12 lg:col-span-9 space-y-6">
          
          {activeTab === 'dashboard' ? (
            <>
              {/* Machine Bar */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-4">
                  <div>
                    <h2 className="text-2xl font-bold tracking-tight">Gerenciador de Hosts</h2>
                    <p className="text-sm text-gray-500">{selectedHosts.length} hosts selecionados para ação em massa.</p>
                  </div>
                  
                  <div className="flex bg-[#1A1B1E] rounded-lg p-1 border border-white/5 ml-4">
                    <button 
                      onClick={() => setStatusFilter('all')}
                      className={`px-3 py-1 rounded-md text-[10px] font-bold uppercase tracking-wider transition-all ${statusFilter === 'all' ? 'bg-white text-black' : 'text-gray-500 hover:text-white'}`}
                    >
                      Todos
                    </button>
                    <button 
                      onClick={() => setStatusFilter('online')}
                      className={`px-3 py-1 rounded-md text-[10px] font-bold uppercase tracking-wider transition-all ${statusFilter === 'online' ? 'bg-emerald-500 text-white' : 'text-gray-500 hover:text-emerald-500'}`}
                    >
                      Online
                    </button>
                  </div>

                  <div className="relative ml-2">
                    <input 
                      type="text"
                      placeholder="Pesquisar por Nome ou IP..."
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      className="bg-[#1A1B1E] border border-white/5 rounded-lg px-4 py-1.5 text-xs focus:outline-none focus:border-blue-500/50 w-64 transition-all"
                    />
                    {searchQuery && (
                      <button 
                        onClick={() => setSearchQuery('')}
                        className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-500 hover:text-white"
                      >
                        <XCircle size={14} />
                      </button>
                    )}
                  </div>
                </div>
                <div className="flex gap-2">
                  {selectedHosts.length > 0 && (
                    <button 
                      onClick={() => {
                        setScriptToRun(null);
                        setScriptTargetHosts(selectedHosts);
                        setIsRunScriptModalOpen(true);
                      }}
                      className="px-4 py-2 bg-emerald-600/10 text-emerald-500 border border-emerald-600/20 font-bold rounded-lg hover:bg-emerald-600 hover:text-white transition-all flex items-center gap-2"
                    >
                      <FileCode size={18} /> Scripts em Massa
                    </button>
                  )}
                  <button 
                    onClick={() => setIsAddModalOpen(true)}
                    className="px-4 py-2 bg-white text-black font-bold rounded-lg hover:bg-gray-200 transition-all flex items-center gap-2"
                  >
                    <Plus size={18} /> Cadastrar Máquina
                  </button>
                </div>
              </div>

              {/* Table */}
              <div className="bg-[#151619] border border-white/5 rounded-2xl overflow-hidden shadow-2xl">
                <div className="grid grid-cols-12 gap-4 p-4 border-b border-white/5 text-[10px] uppercase font-mono text-gray-500 tracking-widest bg-[#111113]">
                  <div className="col-span-1 flex items-center justify-center">
                    <input 
                      type="checkbox" 
                      onChange={(e) => setSelectedHosts(e.target.checked ? machines.map(m => m.ip) : [])}
                      checked={selectedHosts.length === machines.length && machines.length > 0}
                    />
                  </div>
                  <div className="col-span-1">Status</div>
                  <div className="col-span-4">Identificação</div>
                  <div className="col-span-2">Endereço IP</div>
                  <div className="col-span-2">Última Atividade</div>
                  <div className="col-span-2 text-center">Ações</div>
                </div>

                <div className="divide-y divide-white/5 max-h-[600px] overflow-y-auto">
                  {machines.length === 0 ? (
                    <div className="p-12 text-center text-gray-500">
                      <Monitor size={48} className="mx-auto mb-4 opacity-20" />
                      <p>Nenhuma máquina cadastrada no sistema.</p>
                    </div>
                  ) : currentMachines.length === 0 ? (
                    <div className="p-12 text-center text-gray-500">
                      <p>Nenhuma máquina encontrada nos filtros atuais.</p>
                    </div>
                  ) : currentMachines.map(m => (
                    <div key={m.id} className="grid grid-cols-12 gap-4 p-4 items-center hover:bg-white/[0.02] transition-colors">
                      <div className="col-span-1 flex items-center justify-center">
                        <input 
                          type="checkbox" 
                          checked={selectedHosts.includes(m.ip)}
                          onChange={() => setSelectedHosts(prev => prev.includes(m.ip) ? prev.filter(h => h !== m.ip) : [...prev, m.ip])}
                        />
                      </div>
                      <div className="col-span-1 flex items-center justify-center">
                        <div className={`w-2.5 h-2.5 rounded-full ${
                          m.status === 'online' ? 'bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]' : 
                          m.status === 'offline' ? 'bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.5)]' : 
                          'bg-gray-600'
                        }`} />
                      </div>
                      <div className="col-span-4 font-medium">{m.name}</div>
                      <div className="col-span-2 font-mono text-sm text-blue-400">{m.ip}</div>
                      <div className="col-span-2 text-xs text-gray-500">
                        {m.lastPing ? new Date(m.lastPing).toLocaleTimeString() : '---'}
                      </div>
                      <div className="col-span-2 flex justify-center gap-3 text-gray-600">
                        <button 
                          onClick={() => {
                            setScriptToRun(null);
                            setScriptTargetHosts([m.ip]);
                            setIsRunScriptModalOpen(true);
                          }}
                          className="hover:text-emerald-500 transition-colors"
                          title="Executar Script"
                          disabled={m.status !== 'online'}
                        >
                          <FileCode size={16} className={m.status !== 'online' ? 'opacity-20' : ''} />
                        </button>
                        <button 
                          onClick={() => openTerminal(m.ip)}
                          className="hover:text-amber-500 transition-colors"
                          title="Shell WMI (Interativo)"
                        >
                          <Cpu size={16} />
                        </button>
                        <button 
                          onClick={() => {
                            setTempExecHost([m.ip]);
                            setIsExecModalOpen(true);
                          }}
                          className="hover:text-blue-500 transition-colors"
                          title="Comando Único (PsExec)"
                        >
                          <Terminal size={16} />
                        </button>
                        <button 
                          onClick={() => deleteMachine(m.id)}
                          className="hover:text-red-500 transition-colors"
                          title="Excluir"
                        >
                          <Trash2 size={16} />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>

                {/* Pagination Footer */}
                {totalPages > 1 && (
                  <div className="px-6 py-4 bg-[#111113] border-t border-white/5 flex items-center justify-between">
                    <span className="text-[10px] text-gray-500 font-mono uppercase tracking-widest">
                      Mostrando {(currentPage - 1) * itemsPerPage + 1} - {Math.min(currentPage * itemsPerPage, filteredMachines.length)} de {filteredMachines.length}
                    </span>
                    <div className="flex gap-1">
                      {Array.from({ length: totalPages }, (_, i) => i + 1).map(page => (
                        <button
                          key={page}
                          onClick={() => setCurrentPage(page)}
                          className={`w-8 h-8 rounded-lg text-xs font-bold transition-all ${
                            currentPage === page 
                              ? 'bg-blue-600 text-white shadow-lg shadow-blue-900/20' 
                              : 'bg-white/5 text-gray-400 hover:bg-white/10 hover:text-white'
                          }`}
                        >
                          {page}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {/* Console Output */}
              <div className="bg-[#111] rounded-2xl border border-white/5 p-4 shadow-inner overflow-hidden flex flex-col h-[300px] relative group">
                <div className="flex items-center justify-between mb-3 pb-2 border-b border-white/5">
                  <div className="flex items-center gap-2">
                    <Terminal size={14} className="text-gray-500" />
                    <span className="text-[10px] font-mono uppercase text-gray-500 tracking-widest">Saída do Console</span>
                  </div>
                  <button 
                    onClick={() => setIsConsoleOpen(true)}
                    className="text-[10px] bg-blue-600/10 text-blue-500 px-2 py-0.5 rounded border border-blue-600/20 hover:bg-blue-600 hover:text-white transition-all cursor-pointer"
                  >
                    ABRIR TERMINAL CHEIO
                  </button>
                </div>
                <div className="flex-1 overflow-y-auto font-mono text-[11px] space-y-1 text-blue-300/80 p-2 scrollbar-thin scrollbar-thumb-white/10">
                  {log.map((line, i) => (
                    <div key={i} className="flex gap-2">
                      <span className="opacity-20 select-none text-[9px] w-6 text-right font-mono">{i + 1}</span>
                      <span className="whitespace-pre-wrap">{line}</span>
                    </div>
                  ))}
                  {log.length === 0 && <span className="text-gray-700 italic">Pronto para execução...</span>}
                  <div ref={consoleLogEndRef} id="anchor" />
                </div>
              </div>
            </>
          ) : (
            <div className="space-y-6">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-2xl font-bold tracking-tight">Sistema & Credenciais</h2>
                  <p className="text-sm text-gray-500">Configure os parâmetros de autenticação para o PsExec.</p>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="bg-[#151619] border border-white/5 rounded-2xl p-6">
                  <div className="flex items-center gap-3 mb-6">
                    <div className="w-10 h-10 bg-white/5 rounded-xl flex items-center justify-center border border-white/10">
                      <Lock className="text-blue-500" size={20} />
                    </div>
                    <h3 className="font-bold">Acesso Remoto</h3>
                  </div>
                  <div className="space-y-4">
                    <div>
                      <label className="block text-[10px] uppercase text-gray-500 font-mono mb-1.5">Usuário Administrador</label>
                      <input 
                        type="text" 
                        value={creds.username}
                        onChange={e => setCreds({...creds, username: e.target.value})}
                        className="w-full bg-[#0A0A0B] border border-white/10 rounded-xl px-4 py-3 text-sm focus:outline-none focus:border-blue-500 transition-colors"
                        placeholder="DOMAIN\Administrator"
                      />
                    </div>
                    <div>
                      <label className="block text-[10px] uppercase text-gray-500 font-mono mb-1.5">Senha de Acesso</label>
                      <input 
                        type="password" 
                        value={creds.password}
                        onChange={e => setCreds({...creds, password: e.target.value})}
                        className="w-full bg-[#0A0A0B] border border-white/10 rounded-xl px-4 py-3 text-sm focus:outline-none focus:border-blue-500 transition-colors"
                        placeholder="••••••••"
                      />
                    </div>
                    <button 
                      onClick={saveCreds}
                      className="w-full py-3 bg-blue-600 text-white font-bold rounded-xl mt-2 hover:bg-blue-700 transition-all flex items-center justify-center gap-2"
                    >
                      <CheckCircle size={18} /> Salvar Parâmetros
                    </button>
                  </div>
                </div>

                <div className="bg-[#151619] border border-white/5 rounded-2xl p-6 flex flex-col justify-between">
                  <div>
                    <div className="flex items-center gap-3 mb-6">
                      <div className="w-10 h-10 bg-white/5 rounded-xl flex items-center justify-center border border-white/10">
                        <Activity className="text-emerald-500" size={20} />
                      </div>
                      <h3 className="font-bold">Integridade de Dados</h3>
                    </div>
                    <p className="text-sm text-gray-400 mb-6 leading-relaxed">
                      Todas as máquinas e credenciais são criptografadas em repouso e só podem ser acessadas pelo seu ID de proprietário verificado. O teste de ping é realizado pelo servidor para evitar restrições de CORS locais.
                    </p>
                  </div>
                  <div className="p-4 bg-blue-500/10 border border-blue-500/20 rounded-xl flex gap-3">
                    <Shield className="text-blue-500 shrink-0" size={20} />
                    <p className="text-[10px] text-blue-400 font-medium leading-relaxed uppercase tracking-wide">
                      O PsManager Pro utiliza os protocolos SMB e RPC para execução. Certifique-se de que o firewall das máquinas remotas permite o tráfego nas portas 445 e 135-139.
                    </p>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </main>

      {/* --- Modals --- */}
      
      {/* Add Machine Modal */}
      <AnimatePresence>
        {isAddModalOpen && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center px-4 bg-black/80 backdrop-blur-sm">
            <motion.form 
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.9 }}
              onSubmit={addMachine}
              className="bg-[#151619] border border-white/10 rounded-3xl p-8 w-full max-w-md shadow-2xl"
            >
              <h3 className="text-xl font-bold mb-6 flex items-center gap-2">
                <Plus className="text-blue-500" /> Cadastrar Novo Host
              </h3>
              
              <div className="bg-blue-500/5 border border-blue-500/10 rounded-xl p-4 mb-6">
                <label className="block text-[10px] uppercase text-blue-500 font-bold mb-2">Importação em Massa (CSV)</label>
                <input 
                  type="file" 
                  accept=".csv"
                  onChange={handleCsvUpload}
                  className="text-xs text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-xs file:font-semibold file:bg-blue-500 file:text-white hover:file:bg-blue-600"
                />
                <p className="text-[10px] text-gray-500 mt-2 italic">Formato: nome,ip (um por linha)</p>
              </div>

              <div className="w-full h-[1px] bg-white/5 mb-6" />

              <div className="space-y-4 mb-8">
                <div>
                  <label className="block text-[10px] uppercase text-gray-500 mb-1">Nome da Máquina</label>
                  <input 
                    required
                    autoFocus
                    type="text" 
                    value={newMachine.name}
                    onChange={e => setNewMachine({...newMachine, name: e.target.value})}
                    placeholder="ex: Workstation-01"
                    className="w-full bg-[#0A0A0B] border border-white/10 rounded-xl px-4 py-3 text-sm focus:outline-none focus:border-blue-500"
                  />
                </div>
                <div>
                  <label className="block text-[10px] uppercase text-gray-500 mb-1">Endereço IP ou Hostname</label>
                  <input 
                    required
                    type="text" 
                    value={newMachine.ip}
                    onChange={e => setNewMachine({...newMachine, ip: e.target.value})}
                    placeholder="ex: 192.168.1.15"
                    className="w-full bg-[#0A0A0B] border border-white/10 rounded-xl px-4 py-3 text-sm focus:outline-none focus:border-blue-500"
                  />
                </div>
              </div>
              <div className="flex gap-3">
                <button 
                  type="button"
                  onClick={() => setIsAddModalOpen(false)}
                  className="flex-1 py-3 bg-white/5 hover:bg-white/10 rounded-xl text-sm font-bold transition-all"
                >
                  Cancelar
                </button>
                <button 
                  type="submit"
                  className="flex-1 py-3 bg-blue-600 hover:bg-blue-700 text-white rounded-xl text-sm font-bold transition-all"
                >
                  Confirmar Cadastro
                </button>
              </div>
            </motion.form>
          </div>
        )}
      </AnimatePresence>

      {/* Custom CMD Modal */}
      <AnimatePresence>
        {isExecModalOpen && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center px-4 bg-black/80 backdrop-blur-sm">
            <motion.div 
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.9 }}
              className="bg-[#151619] border border-white/10 rounded-3xl p-8 w-full max-w-lg shadow-2xl"
            >
              <div className="flex justify-between items-start mb-2">
                <div>
                  <h3 className="text-xl font-bold mb-1 flex items-center gap-2">
                    <Terminal className="text-blue-500" /> Execução Remota
                  </h3>
                  <p className="text-xs text-gray-500 font-mono capitals">
                    ENVIANDO COMANDO PARA {tempExecHost ? tempExecHost[0] : selectedHosts.length + ' HOSTS'}
                  </p>
                </div>
                <button 
                  onClick={() => {
                    setExecResult(null);
                    setCustomCommand('');
                    setIsExecModalOpen(false);
                    setTempExecHost(null);
                  }}
                  className="p-2 hover:bg-white/5 rounded-full transition-colors text-gray-500 hover:text-white"
                >
                  <XCircle size={20} />
                </button>
              </div>
              
              <div className="bg-black rounded-xl p-4 mb-4 border border-white/5 shadow-inner">
                <div className="flex gap-2 text-emerald-500 font-mono text-sm mb-2">
                  <span className="shrink-0 tracking-tighter">C:\Windows\system32{'>'}</span>
                  <input 
                    autoFocus
                    type="text" 
                    value={customCommand}
                    onChange={e => setCustomCommand(e.target.value)}
                    className="bg-transparent border-none outline-none flex-1 min-w-0"
                    placeholder="..."
                    onKeyPress={async e => {
                      if (e.key === 'Enter' && customCommand.trim()) {
                        setExecLoading(true);
                        const res = await executeRemote(customCommand, tempExecHost || undefined);
                        setExecResult(res);
                        setExecLoading(false);
                        setCustomCommand('');
                      }
                    }}
                  />
                  {execLoading && <RefreshCw size={14} className="animate-spin text-blue-500" />}
                </div>
                <div className="text-[10px] text-gray-600 uppercase tracking-tighter">Enter para executar</div>
              </div>

              {/* Action output area */}
              {(execResult || execLoading) && (
                <div className="bg-black/50 border border-white/5 rounded-xl p-4 mb-6 max-h-64 overflow-y-auto custom-scrollbar font-mono text-[11px]">
                  {execLoading ? (
                    <div className="flex items-center gap-2 text-blue-400 animate-pulse">
                      <RefreshCw size={10} className="animate-spin" />
                      <span>EXECUTANDO COMANDO...</span>
                    </div>
                  ) : execResult?.map((r, i) => (
                    <div key={i} className="mb-2 last:mb-0">
                      <div className={`font-bold ${r.status === 'success' ? 'text-emerald-500' : 'text-red-500'}`}>
                        [{r.host}] {r.status.toUpperCase()}
                      </div>
                      <pre className="text-gray-400 whitespace-pre-wrap break-all mt-1">{r.output || 'Sem saída.'}</pre>
                    </div>
                  ))}
                </div>
              )}

              <div className="flex gap-3">
                <button 
                  onClick={() => {
                    setExecResult(null);
                    setCustomCommand('');
                    setIsExecModalOpen(false);
                    setTempExecHost(null);
                  }}
                  className="px-6 py-3 bg-white/5 hover:bg-white/10 rounded-xl text-sm font-bold transition-all"
                >
                  Fechar
                </button>
                <button 
                  disabled={execLoading || !customCommand.trim()}
                  onClick={async () => {
                    setExecLoading(true);
                    const res = await executeRemote(customCommand, tempExecHost || undefined);
                    setExecResult(res);
                    setExecLoading(false);
                    setCustomCommand('');
                  }}
                  className="flex-1 py-3 bg-blue-600 hover:bg-blue-700 text-white rounded-xl text-sm font-bold transition-all disabled:opacity-50"
                >
                  Executar Agora
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* App Management Modal */}
      <AnimatePresence>
        {isAppModalOpen && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center px-4 bg-black/80 backdrop-blur-sm">
            <motion.div 
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.9 }}
              className="bg-[#111] border border-white/10 rounded-3xl p-8 w-full max-w-2xl shadow-2xl max-h-[80vh] flex flex-col"
            >
              <div className="flex justify-between items-center mb-6">
                <h3 className="text-xl font-bold flex items-center gap-2">
                  <Activity className="text-blue-500" /> Aplicativos Instalados
                </h3>
                <button onClick={() => setIsAppModalOpen(false)} className="text-gray-500 hover:text-white transition-colors">
                  <XCircle size={24} />
                </button>
              </div>
              
              <div className="flex-1 overflow-y-auto space-y-2 pr-2 custom-scrollbar">
                {installedApps.length === 0 ? (
                  <p className="text-center text-gray-500 py-12">Nenhum aplicativo encontrado ou erro na listagem.</p>
                ) : installedApps.map((app, i) => (
                  <div key={i} className="flex items-center justify-between p-3 bg-white/5 border border-white/5 rounded-xl hover:bg-white/10 transition-all group">
                    <span className="text-sm font-medium">{app}</span>
                    <button 
                      onClick={() => uninstallApp(app)}
                      className="px-3 py-1 bg-red-500/10 text-red-500 text-[10px] font-bold rounded-lg opacity-0 group-hover:opacity-100 hover:bg-red-500 hover:text-white transition-all transform hover:scale-105"
                    >
                      DESINSTALAR
                    </button>
                  </div>
                ))}
              </div>
              
              <div className="mt-6 pt-4 border-t border-white/5 text-[10px] text-gray-500 uppercase text-center tracking-widest">
                Exibindo resultados para {selectedHosts[0]}
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Loading Overlay Modal */}
      <AnimatePresence>
        {isWaitModalOpen && (
          <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 backdrop-blur-md">
            <div className="text-center space-y-4">
              <RefreshCw className="animate-spin text-blue-500 mx-auto" size={48} />
              <p className="text-sm font-mono text-blue-400 animate-pulse tracking-widest uppercase">Consultando Servidor Remoto...</p>
            </div>
          </div>
        )}
      </AnimatePresence>

      {/* IP Config Modal */}
      <AnimatePresence>
        {isIPModalOpen && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center px-4 bg-black/80 backdrop-blur-sm">
            <motion.div 
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.9 }}
              className="bg-[#151619] border border-white/10 rounded-3xl p-8 w-full max-w-md shadow-2xl"
            >
              <h3 className="text-xl font-bold mb-6 flex items-center gap-2">
                <Globe className="text-blue-500" /> Configuração Estática de IP
              </h3>
              <div className="space-y-4 mb-8">
                <div>
                  <label className="block text-[10px] uppercase text-gray-500 mb-1">Novo Endereço IPv4</label>
                  <input 
                    type="text" 
                    value={ipConfig.ip}
                    onChange={e => setIpConfig({...ipConfig, ip: e.target.value})}
                    placeholder="10.0.0.x"
                    className="w-full bg-[#0A0A0B] border border-white/10 rounded-xl px-4 py-3 text-sm focus:outline-none focus:border-blue-500"
                  />
                </div>
                <div>
                  <label className="block text-[10px] uppercase text-gray-500 mb-1">Máscara de Sub-rede</label>
                  <input 
                    type="text" 
                    value={ipConfig.mask}
                    onChange={e => setIpConfig({...ipConfig, mask: e.target.value})}
                    placeholder="255.255.255.0"
                    className="w-full bg-[#0A0A0B] border border-white/10 rounded-xl px-4 py-3 text-sm focus:outline-none focus:border-blue-500"
                  />
                </div>
                <div>
                  <label className="block text-[10px] uppercase text-gray-500 mb-1">Gateway Padrão</label>
                  <input 
                    type="text" 
                    value={ipConfig.gw}
                    onChange={e => setIpConfig({...ipConfig, gw: e.target.value})}
                    placeholder="10.0.0.1"
                    className="w-full bg-[#0A0A0B] border border-white/10 rounded-xl px-4 py-3 text-sm focus:outline-none focus:border-blue-500"
                  />
                </div>
              </div>
              <div className="flex gap-3">
                <button 
                  onClick={() => setIsIPModalOpen(false)}
                  className="flex-1 py-3 bg-white/5 rounded-xl text-sm font-bold transition-all"
                >
                  Cancelar
                </button>
                <button 
                  onClick={() => {
                    const cmd = `netsh interface ip set address name="Ethernet" static ${ipConfig.ip} ${ipConfig.mask} ${ipConfig.gw}`;
                    executeRemote(cmd);
                    setIsIPModalOpen(false);
                  }}
                  className="flex-1 py-3 bg-blue-600 text-white rounded-xl text-sm font-bold transition-all"
                >
                  Aplicar Configuração
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Scripts Manager Modal */}
      <AnimatePresence>
        {isScriptManagerOpen && (
          <div className="fixed inset-0 z-[160] flex items-center justify-center p-4 bg-black/90 backdrop-blur-md">
            <motion.div 
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="bg-[#151619] border border-white/10 rounded-3xl w-full max-w-2xl overflow-hidden shadow-2xl flex flex-col"
            >
              <div className="px-8 py-6 border-b border-white/5 flex items-center justify-between bg-[#111113]">
                <div className="flex items-center gap-3">
                  <div className="p-2 bg-blue-500/10 rounded-lg">
                    <ScrollText className="text-blue-500" size={24} />
                  </div>
                  <div>
                    <h3 className="font-bold text-lg">Repositório de Scripts</h3>
                    <p className="text-[10px] text-gray-500 font-mono uppercase tracking-widest">Apenas arquivos .bat são aceitos</p>
                  </div>
                </div>
                <button onClick={() => setIsScriptManagerOpen(false)} className="p-2 hover:bg-white/5 rounded-full">
                  <XCircle size={24} className="text-gray-500 hover:text-white" />
                </button>
              </div>

              <div className="p-8 flex-1 overflow-y-auto space-y-6">
                {/* Upload Section */}
                <div className="p-6 bg-blue-600/5 border border-blue-600/20 rounded-2xl">
                  <h4 className="text-xs font-bold uppercase tracking-widest text-blue-400 mb-4 flex items-center gap-2">
                    <UploadCloud size={14} /> Novo Script
                  </h4>
                  <div className="flex gap-3">
                    <input 
                      type="text"
                      id="new-script-name"
                      placeholder="nome_do_script.bat"
                      className="flex-1 bg-black border border-white/10 rounded-xl px-4 py-3 text-sm outline-none focus:border-blue-500 transition-all"
                    />
                    <button 
                      onClick={() => {
                        const nameEl = document.getElementById('new-script-name') as HTMLInputElement;
                        const contentEl = document.getElementById('new-script-content') as HTMLTextAreaElement;
                        if (nameEl.value && contentEl.value) {
                          uploadScript(nameEl.value, contentEl.value);
                          nameEl.value = '';
                          contentEl.value = '';
                        }
                      }}
                      className="px-6 py-3 bg-blue-600 hover:bg-blue-700 text-white font-bold rounded-xl text-sm transition-all shadow-lg shadow-blue-900/20"
                    >
                      Salvar
                    </button>
                  </div>
                  <textarea 
                    id="new-script-content"
                    placeholder="Cole o conteúdo do seu script aqui..."
                    className="w-full h-32 mt-3 bg-black border border-white/10 rounded-xl px-4 py-3 text-xs font-mono outline-none focus:border-blue-500 transition-all resize-none"
                  />
                </div>

                {/* List Section */}
                <div className="space-y-3">
                  <h4 className="text-xs font-bold uppercase tracking-widest text-gray-500 mb-2">Scripts Disponíveis ({scripts.length})</h4>
                  {scripts.length === 0 ? (
                    <div className="text-center py-8 text-gray-600 italic text-sm">
                      Nenhum script cadastrado no servidor.
                    </div>
                  ) : (
                    <div className="grid grid-cols-1 gap-2">
                      {scripts.map(s => (
                        <div key={s} className="group p-4 bg-[#1A1B1E] border border-white/5 rounded-xl flex items-center justify-between hover:border-blue-500/30 transition-all">
                          <div className="flex items-center gap-3">
                            <FileCode size={20} className="text-blue-500" />
                            <span className="text-sm font-mono text-gray-300">{s}</span>
                          </div>
                          <button 
                            onClick={() => deleteScript(s)}
                            className="p-2 text-gray-600 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-all"
                          >
                            <Trash2 size={16} />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Run Script Modal */}
      <AnimatePresence>
        {isRunScriptModalOpen && (
          <div className="fixed inset-0 z-[160] flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
            <motion.div 
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 20 }}
              className="bg-[#151619] border border-white/10 rounded-3xl w-full max-w-md p-8 shadow-2xl"
            >
              <h3 className="text-xl font-bold mb-2 flex items-center gap-2">
                <Play className="text-emerald-500" /> Executar Script
              </h3>
              <p className="text-xs text-gray-500 mb-6">Executando em {scriptTargetHosts.length} hosts selecionados.</p>

              <div className="space-y-4 mb-8">
                <label className="block text-[10px] uppercase text-gray-500 font-bold mb-1">Selecione o Script</label>
                <div className="grid grid-cols-1 gap-2 max-h-48 overflow-y-auto pr-2 custom-scrollbar">
                  {scripts.length === 0 ? (
                    <div className="text-center p-4 border border-dashed border-white/10 rounded-xl text-gray-600 text-xs italic">
                      Nenhum script disponível. Vá em Gerenciar Scripts.
                    </div>
                  ) : scripts.map(s => (
                    <button 
                      key={s}
                      onClick={() => setScriptToRun(s)}
                      className={`p-4 rounded-xl border text-left flex items-center justify-between transition-all ${
                        scriptToRun === s 
                          ? 'bg-blue-600/10 border-blue-500 text-white' 
                          : 'bg-black/40 border-white/5 text-gray-400 hover:border-white/20'
                      }`}
                    >
                      <span className="text-sm font-mono truncate">{s}</span>
                      {scriptToRun === s && <CheckCircle size={16} className="text-blue-500" />}
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex gap-3">
                <button 
                  onClick={() => setIsRunScriptModalOpen(false)}
                  className="flex-1 py-3 bg-white/5 rounded-xl text-sm font-bold transition-all"
                >
                  Cancelar
                </button>
                <button 
                  disabled={!scriptToRun}
                  onClick={() => scriptToRun && executeScriptOnHosts(scriptToRun, scriptTargetHosts)}
                  className="flex-1 py-3 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl text-sm font-bold transition-all disabled:opacity-50 disabled:cursor-not-allowed shadow-lg shadow-emerald-900/20"
                >
                  Iniciar Execução
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Terminal WMI Modal */}
      <AnimatePresence>
        {isTerminalOpen && (
          <div className="fixed inset-0 z-[150] flex items-center justify-center p-4 bg-black/90 backdrop-blur-md">
            <motion.div 
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 20 }}
              className="bg-[#111] border border-white/10 rounded-2xl w-full max-w-4xl h-[80vh] flex flex-col shadow-2xl overflow-hidden"
            >
              {/* Header */}
              <div className="px-6 py-4 border-b border-white/5 flex items-center justify-between bg-[#151619]">
                <div className="flex items-center gap-3">
                  <div className="p-2 bg-amber-500/10 rounded-lg">
                    <Cpu className="text-amber-500" size={20} />
                  </div>
                  <div>
                    <h3 className="font-bold text-sm">Shell Interativo (WMI)</h3>
                    <p className="text-[10px] text-gray-500 font-mono tracking-tighter uppercase">Conectado em: {terminalHost}</p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button 
                    onClick={() => setTerminalLog([])}
                    className="p-2 hover:bg-white/5 rounded-lg transition-all text-gray-500 hover:text-white"
                    title="Limpar Terminal"
                  >
                    <Trash2 size={16} />
                  </button>
                  <button 
                    onClick={() => setIsTerminalOpen(false)}
                    className="p-2 hover:bg-white/5 rounded-full transition-all"
                  >
                    <XCircle size={22} className="text-gray-500 hover:text-red-500" />
                  </button>
                </div>
              </div>

              {/* Terminal Area */}
              <div className="flex-1 bg-black p-6 font-mono text-sm overflow-y-auto custom-scrollbar flex flex-col gap-2">
                {terminalLog.map((entry, i) => (
                  <div key={i} className={`flex gap-3 ${entry.type === 'in' ? 'text-blue-400' : 'text-gray-300'}`}>
                    <span className="shrink-0 opacity-40 select-none">
                      {entry.type === 'in' ? '>' : '#'}
                    </span>
                    <pre className="whitespace-pre-wrap break-all leading-relaxed">
                      {entry.text}
                    </pre>
                  </div>
                ))}
                {terminalLoading && (
                  <div className="flex gap-2 items-center text-blue-500/50 animate-pulse mt-2">
                    <span className="animate-spin text-xs">/</span>
                    <span className="text-[10px] font-bold uppercase tracking-widest">Processando...</span>
                  </div>
                )}
                <div ref={terminalEndRef} />
              </div>

              {/* Input Area */}
              <div className="p-4 bg-[#151619] border-t border-white/5">
                <form 
                  onSubmit={(e) => {
                    e.preventDefault();
                    const input = e.currentTarget.cmd.value;
                    if (input) {
                      sendTerminalCommand(input);
                      e.currentTarget.cmd.value = '';
                    }
                  }}
                  className="flex gap-3 bg-black border border-white/5 rounded-xl px-4 py-3 focus-within:border-blue-500/50 transition-all"
                >
                  <span className="text-emerald-500 font-bold tracking-tighter">CMD_</span>
                  <input 
                    name="cmd"
                    autoFocus
                    autoComplete="off"
                    disabled={terminalLoading}
                    placeholder="Digite o comando remoto..."
                    className="flex-1 bg-transparent border-none outline-none text-white text-sm"
                  />
                  <div className="text-[10px] text-gray-600 font-mono flex items-center gap-2">
                    <span className="px-1.5 py-0.5 border border-white/10 rounded">ENTER</span>
                  </div>
                </form>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Console Output Modal - Full View */}
      <AnimatePresence>
        {isConsoleOpen && (
          <div className="fixed inset-0 z-[200] flex items-center justify-center p-4 bg-black/80 backdrop-blur-md">
            <motion.div 
              initial={{ opacity: 0, scale: 0.9, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9, y: 20 }}
              className="w-full max-w-6xl h-[90vh] bg-[#0A0A0B] border border-white/10 rounded-2xl shadow-3xl overflow-hidden flex flex-col"
            >
              <div className="bg-[#111113] px-6 py-5 border-b border-white/5 flex items-center justify-between">
                <div className="flex items-center gap-4">
                  <div className="w-12 h-12 bg-blue-600/10 text-blue-500 rounded-xl flex items-center justify-center border border-blue-600/20 shadow-lg shadow-blue-900/10">
                    <Terminal size={24} />
                  </div>
                  <div>
                    <h2 className="text-lg font-bold tracking-tight">TERMINAL_DEBUG</h2>
                    <p className="text-xs text-gray-500 font-mono tracking-widest uppercase">Saída bruta PsExec/CMD</p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button 
                    onClick={() => setConsoleLog([])}
                    className="px-4 py-2 bg-white/5 hover:bg-white/10 border border-white/10 rounded-lg text-xs font-mono transition-all text-gray-400 hover:text-white uppercase tracking-tighter"
                  >
                    Clear_History
                  </button>
                  <button 
                    onClick={() => setIsConsoleOpen(false)}
                    className="p-2 hover:bg-red-600/20 text-gray-500 hover:text-red-500 rounded-lg transition-all"
                  >
                    <XCircle size={24} />
                  </button>
                </div>
              </div>

              <div className="flex-1 bg-black p-8 overflow-y-auto font-mono text-[13px] leading-relaxed relative">
                <div className="space-y-6 max-w-full">
                  {consoleLog.length === 0 && (
                    <div className="absolute inset-0 flex flex-col items-center justify-center text-gray-800 space-y-4">
                      <Activity size={64} className="opacity-10 animate-pulse" />
                      <p className="text-[10px] uppercase font-bold tracking-[0.4em] opacity-30">Waiting for remote execution results...</p>
                    </div>
                  )}
                  {consoleLog.map((entry, i) => (
                    <div key={i} className="group animate-in fade-in duration-500">
                      <div className="flex items-center gap-3 mb-2 opacity-60 group-hover:opacity-100 transition-opacity">
                        <span className={`text-[9px] px-2 py-0.5 rounded-sm font-bold tracking-widest ${
                          entry.type === 'system' ? 'bg-gray-800 text-gray-400' :
                          entry.type === 'cmd' ? 'bg-blue-600/20 text-blue-400' :
                          entry.type === 'result' ? 'bg-emerald-600/20 text-emerald-400' :
                          'bg-red-600/20 text-red-500'
                        }`}>
                          {entry.type.toUpperCase()}
                        </span>
                        <span className="text-[9px] text-gray-600">[{new Date().toLocaleTimeString()}]</span>
                        {entry.host && <span className="text-[9px] text-blue-500 font-bold tracking-widest">@{entry.host}</span>}
                      </div>

                      <div className={`p-5 rounded-2xl border font-mono whitespace-pre-wrap break-all transition-all shadow-lg ${
                        entry.type === 'cmd' ? 'bg-[#151619] border-white/10 text-white font-bold' :
                        entry.type === 'result' ? 'bg-[#000] border-emerald-500/20 text-emerald-400/90' :
                        entry.type === 'error' ? 'bg-red-950/20 border-red-500/20 text-red-400' :
                        'bg-transparent border-transparent text-gray-600 italic border-l-gray-800'
                      }`}>
                        {entry.text}
                      </div>
                    </div>
                  ))}
                  <div ref={consoleLogEndRef} />
                </div>
              </div>
              
              <div className="p-6 bg-[#0D0D0E] border-t border-white/5">
                <div className="max-w-4xl mx-auto flex items-center bg-black border border-white/10 rounded-2xl px-5 focus-within:border-blue-500/50 focus-within:shadow-[0_0_20px_rgba(59,130,246,0.1)] transition-all">
                  <Terminal size={18} className="text-gray-600 mr-4 shrink-0" />
                  <input 
                    type="text" 
                    placeholder="DIGITE UM COMANDO PARA EXECUTAR NOS HOSTS SELECIONADOS..." 
                    className="flex-1 bg-transparent py-4 text-sm font-mono text-white placeholder:text-gray-700 focus:outline-none"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && e.currentTarget.value.trim()) {
                        executeRemote(e.currentTarget.value);
                        e.currentTarget.value = '';
                      }
                    }}
                  />
                  <div className="flex items-center gap-4 text-gray-700 ml-4 shrink-0 select-none">
                    <div className="h-4 w-[1px] bg-white/10" />
                    <span className="text-[9px] font-bold uppercase tracking-widest text-blue-500/40">Remote_Exec</span>
                  </div>
                </div>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

    </div>
  );
};

export default App;
