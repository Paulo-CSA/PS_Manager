import React, { useState, useEffect, useRef } from 'react';
import { 
  auth, db, googleProvider, signInWithPopup, signInAnonymously, onAuthStateChanged, 
  collection, addDoc, deleteDoc, onSnapshot, query, where, doc, setDoc, getDoc, updateDoc,
  User 
} from './firebase';
import { 
  Monitor, Settings, Plus, Trash2, Play, Activity, 
  Shield, Terminal, Cpu, CheckCircle, XCircle, RefreshCw,
  LogOut, ChevronRight, Globe, Lock, Key
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

// --- Components ---

const App = () => {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [machines, setMachines] = useState<Machine[]>([]);
  const [selectedHosts, setSelectedHosts] = useState<string[]>([]);
  const [creds, setCreds] = useState<Credentials>({ username: '', password: '' });
  const [log, setLog] = useState<string[]>([]);
  const [activeTab, setActiveTab] = useState<'dashboard' | 'config'>('dashboard');
  
  // Modals
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [isExecModalOpen, setIsExecModalOpen] = useState(false);
  const [isIPModalOpen, setIsIPModalOpen] = useState(false);
  const [isAppModalOpen, setIsAppModalOpen] = useState(false);
  const [isWaitModalOpen, setIsWaitModalOpen] = useState(false);
  
  // Forms
  const [newMachine, setNewMachine] = useState({ name: '', ip: '' });
  const [customCommand, setCustomCommand] = useState('');
  const [ipConfig, setIpConfig] = useState({ ip: '', mask: '255.255.255.0', gw: '' });
  const [installedApps, setInstalledApps] = useState<string[]>([]);
  const [tempExecHost, setTempExecHost] = useState<string[] | null>(null);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (u) => {
      if (!u) {
        signInAnonymously(auth).catch(console.error);
        return;
      }
      setUser(u);
      setLoading(false);
      
      // Load machines
      const q = query(collection(db, 'machines'), where('ownerId', '==', u.uid));
      const sub = onSnapshot(q, (snapshot) => {
        setMachines(snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as Machine)));
      });

      // Load credentials
      getDoc(doc(db, 'credentials', u.uid)).then(d => {
        if (d.exists()) setCreds(d.data());
      });

      return () => sub();
    });
    return () => unsubscribe();
  }, []);

  const login = async () => {
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (error) {
      console.error(error);
    }
  };

  const logout = () => auth.signOut();

  const handleCsvUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !user) return;

    const reader = new FileReader();
    reader.onload = async (event) => {
      const text = event.target?.result as string;
      const lines = text.split('\n');
      const batch: any[] = [];

      lines.forEach(line => {
        const [name, ip] = line.split(',').map(s => s.trim());
        if (name && ip) {
          batch.push({
            name,
            ip,
            status: 'unknown',
            ownerId: user.uid,
            createdAt: new Date().toISOString()
          });
        }
      });

      if (batch.length > 0) {
        setLog(prev => [...prev, `[CSV] Iniciando importação de ${batch.length} máquinas...`]);
        for (const item of batch) {
          await addDoc(collection(db, 'machines'), item);
        }
        setLog(prev => [...prev, `[CSV] Importação concluída.`]);
        setIsAddModalOpen(false);
      }
    };
    reader.readAsText(file);
  };

  const addMachine = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user || !newMachine.name || !newMachine.ip) return;
    await addDoc(collection(db, 'machines'), {
      ...newMachine,
      status: 'unknown',
      ownerId: user.uid,
      createdAt: new Date().toISOString()
    });
    setNewMachine({ name: '', ip: '' });
    setIsAddModalOpen(false);
  };

  const deleteMachine = async (id: string) => {
    await deleteDoc(doc(db, 'machines', id));
    setSelectedHosts(prev => prev.filter(h => h !== machines.find(m => m.id === id)?.ip));
  };

  const saveCreds = async () => {
    if (!user) return;
    await setDoc(doc(db, 'credentials', user.uid), {
      ...creds,
      ownerId: user.uid,
      updatedAt: new Date().toISOString()
    });
    setLog(prev => [...prev, `[SYSTEM] Credenciais atualizadas com sucesso.`]);
  };

  const runPing = async () => {
    if (machines.length === 0) return;
    const hosts = machines.map(m => m.ip);
    setLog(prev => [...prev, `[SYSTEM] Iniciando teste de ping em ${hosts.length} máquinas...`]);
    
    try {
      const res = await fetch('/api/ping', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hosts })
      });
      const results = await res.json();
      
      // Update local status in Firestore
      for (const r of results) {
        const machine = machines.find(m => m.ip === r.host);
        if (machine) {
          await updateDoc(doc(db, 'machines', machine.id), {
            status: r.alive ? 'online' : 'offline',
            lastPing: new Date().toISOString()
          });
        }
      }
      setLog(prev => [...prev, `[SYSTEM] Teste de ping concluído.`]);
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
        setLog(prev => [...prev, r.output]);
      });
      return results;
    } catch (err) {
      setLog(prev => [...prev, `[ERROR] Falha na execução remota.`]);
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
    
    const results = await executeRemote('wmic product get name', [host]);
    setIsWaitModalOpen(false);

    if (results && results[0]) {
      const apps = results[0].output.split('\n').filter((a: string) => !a.includes('[') && a.trim() && !a.includes('Name'));
      setInstalledApps(apps);
      setIsAppModalOpen(true);
    }
  };

  const uninstallApp = async (appName: string) => {
    if (!confirm(`Deseja realmente desinstalar "${appName}"?`)) return;
    const host = selectedHosts[0];
    await executeRemote(`wmic product where "name='${appName.trim()}'" call uninstall`, [host]);
    setIsAppModalOpen(false);
  };

  if (loading || !user) return <div className="min-h-screen bg-[#111] flex items-center justify-center text-white font-mono">LOADING_SYSTEM...</div>;

  return (
    <div className="min-h-screen bg-[#0A0A0B] text-[#E4E3E0] font-sans selection:bg-blue-500/30">
      {/* Header */}
      <header className="border-bottom border-white/5 bg-[#111113] px-6 py-4 flex items-center justify-between sticky top-0 z-50">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-blue-600 rounded-lg flex items-center justify-center shadow-lg shadow-blue-900/20">
            <Cpu className="text-white" size={24} />
          </div>
          <div>
            <h1 className="text-lg font-bold tracking-tight leading-none">PS_MANAGER</h1>
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
            {user.photoURL && <img src={user.photoURL} className="w-8 h-8 rounded-full border border-white/10" alt="user" />}
            <div className="flex flex-col text-right">
              <span className="text-[10px] text-gray-500 font-mono">ID_SESSIÃO</span>
              <span className="text-xs font-mono text-blue-400">{user.uid.substring(0, 8)}...</span>
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
                <div>
                  <h2 className="text-2xl font-bold tracking-tight">Gerenciador de Hosts</h2>
                  <p className="text-sm text-gray-500">{selectedHosts.length} hosts selecionados para ação em massa.</p>
                </div>
                <button 
                  onClick={() => setIsAddModalOpen(true)}
                  className="px-4 py-2 bg-white text-black font-bold rounded-lg hover:bg-gray-200 transition-all flex items-center gap-2"
                >
                  <Plus size={18} /> Cadastrar Máquina
                </button>
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

                <div className="divide-y divide-white/5 max-h-[500px] overflow-y-auto">
                  {machines.length === 0 ? (
                    <div className="p-12 text-center text-gray-500">
                      <Monitor size={48} className="mx-auto mb-4 opacity-20" />
                      <p>Nenhuma máquina cadastrada no sistema.</p>
                    </div>
                  ) : machines.map(m => (
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
                      <div className="col-span-2 flex justify-center gap-4 text-gray-600">
                        <button 
                          onClick={() => {
                            setTempExecHost([m.ip]);
                            setIsExecModalOpen(true);
                          }}
                          className="hover:text-blue-500 transition-colors"
                          title="Terminal Remoto"
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
              </div>

              {/* Console Output */}
              <div className="bg-[#111] rounded-2xl border border-white/5 p-4 shadow-inner overflow-hidden flex flex-col h-[300px]">
                <div className="flex items-center gap-2 mb-3 pb-2 border-b border-white/5">
                  <Terminal size={14} className="text-gray-500" />
                  <span className="text-[10px] font-mono uppercase text-gray-500 tracking-widest">Saída do Console</span>
                </div>
                <div className="flex-1 overflow-y-auto font-mono text-xs space-y-1 text-blue-300/80 p-2">
                  {log.map((line, i) => (
                    <div key={i} className="flex gap-2">
                      <span className="opacity-30 select-none">{i + 1}</span>
                      <span>{line}</span>
                    </div>
                  ))}
                  {log.length === 0 && <span className="text-gray-700 italic">Pronto para execução...</span>}
                  <div id="anchor" />
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
              <h3 className="text-xl font-bold mb-2 flex items-center gap-2">
                <Terminal className="text-blue-500" /> Execução Remota
              </h3>
              <p className="text-xs text-gray-500 mb-6 font-mono capitals">
                ENVIANDO COMANDO PARA {tempExecHost ? tempExecHost[0] : selectedHosts.length + ' HOSTS'}
              </p>
              
              <div className="bg-black rounded-xl p-4 mb-6 border border-white/5 shadow-inner">
                <div className="flex gap-2 text-emerald-500 font-mono text-sm mb-2">
                  <span className="shrink-0 tracking-tighter">C:\Windows\system32{'>'}</span>
                  <input 
                    autoFocus
                    type="text" 
                    value={customCommand}
                    onChange={e => setCustomCommand(e.target.value)}
                    className="bg-transparent border-none outline-none flex-1 min-w-0"
                    placeholder="..."
                    onKeyPress={e => e.key === 'Enter' && (executeRemote(customCommand, tempExecHost || undefined), setIsExecModalOpen(false), setTempExecHost(null))}
                  />
                </div>
                <div className="text-[10px] text-gray-600 uppercase tracking-tighter">Enter para executar instantaneamente</div>
              </div>

              <div className="flex gap-3">
                <button 
                  onClick={() => {
                    setIsExecModalOpen(false);
                    setTempExecHost(null);
                  }}
                  className="flex-1 py-3 bg-white/5 rounded-xl text-sm font-bold transition-all"
                >
                  Fechar
                </button>
                <button 
                  onClick={() => {
                    executeRemote(customCommand, tempExecHost || undefined);
                    setCustomCommand('');
                    setIsExecModalOpen(false);
                    setTempExecHost(null);
                  }}
                  className="flex-1 py-3 bg-blue-600 hover:bg-blue-700 text-white rounded-xl text-sm font-bold transition-all"
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

    </div>
  );
};

export default App;
