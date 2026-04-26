import React, { useState, useEffect } from 'react';
import { Trash, X, Search, RefreshCw, Box } from 'lucide-react';

interface AppInventory {
  Name: string;
  Version?: string;
  Publisher?: string;
}

interface SoftwareManagerProps {
  host: string;
  onClose: () => void;
  onLog?: (msg: string) => void;
}

export const SoftwareManager: React.FC<SoftwareManagerProps> = ({ host, onClose, onLog }) => {
  const [apps, setApps] = useState<AppInventory[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [error, setError] = useState<string | null>(null);

  const fetchApps = async () => {
    setLoading(true);
    setError(null);
    if (onLog) onLog(`[SOFTWARE] Iniciando consulta isolada em ${host}...`);
    
    try {
      const res = await fetch('/api/apps', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ host })
      });
      const data = await res.json();
      
      if (res.ok && data.apps) {
        setApps(data.apps);
        if (onLog) onLog(`[SOFTWARE] ${data.apps.length} itens encontrados em ${host}.`);
      } else {
        const msg = data.error || 'Erro na resposta do servidor';
        setError(msg);
        if (onLog) onLog(`[SOFTWARE-ERROR] ${msg}`);
      }
    } catch (err) {
      setError('Erro de conexão com o servidor');
      if (onLog) onLog(`[SOFTWARE-ERROR] Erro de rede.`);
    } finally {
      setLoading(false);
    }
  };

  const uninstallApp = async (appName: string) => {
    if (!confirm(`Confirmar desinstalação de "${appName}" em ${host}?`)) return;
    
    setLoading(true);
    if (onLog) onLog(`[SOFTWARE] Solicitando desinstalação de "${appName}"...`);

    try {
      const res = await fetch('/api/apps/uninstall', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ host, appName })
      });
      const data = await res.json();
      
      if (res.ok && data.success) {
        if (onLog) onLog(`[SOFTWARE] Sucesso: "${appName}" desinstalado.`);
        // Refresh list
        fetchApps();
      } else {
        const msg = data.error || 'Falha na desinstalação';
        setError(msg);
        if (onLog) onLog(`[SOFTWARE-ERROR] ${msg}`);
        setLoading(false);
      }
    } catch (err) {
      setError('Erro ao processar desinstalação');
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchApps();
  }, [host]);

  const filteredApps = apps.filter(app => 
    app.Name.toLowerCase().includes(search.toLowerCase()) ||
    (app.Publisher && app.Publisher.toLowerCase().includes(search.toLowerCase()))
  );

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 md:p-8 bg-black/80 backdrop-blur-md animate-in fade-in duration-300">
      <div className="bg-[#0f1115] w-full max-w-4xl h-[80vh] rounded-3xl border border-white/10 shadow-2xl flex flex-col overflow-hidden relative">
        
        {/* Header */}
        <div className="p-6 border-b border-white/5 flex items-center justify-between bg-white/[0.02]">
          <div className="flex items-center gap-4">
            <div className="p-3 bg-blue-500/20 rounded-2xl">
              <Box className="text-blue-400" size={24} />
            </div>
            <div>
              <h2 className="text-xl font-bold text-white">Inventário de Software</h2>
              <p className="text-xs text-gray-500 font-mono tracking-wider">{host}</p>
            </div>
          </div>
          
          <button 
            onClick={onClose}
            className="p-2 hover:bg-white/10 rounded-xl transition-all text-gray-400 hover:text-white"
          >
            <X size={24} />
          </button>
        </div>

        {/* Toolbar */}
        <div className="px-6 py-4 bg-white/[0.01] border-b border-white/5 flex gap-4 items-center">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" size={16} />
            <input 
              type="text"
              placeholder="Filtrar aplicativos por nome ou publicador..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full bg-white/5 border border-white/10 rounded-xl py-2.5 pl-10 pr-4 text-sm focus:outline-none focus:border-blue-500/50 transition-all"
            />
          </div>
          
          <button 
            onClick={fetchApps}
            disabled={loading}
            className="p-2.5 bg-white/5 border border-white/10 rounded-xl hover:bg-white/10 transition-all disabled:opacity-50 group"
            title="Atualizar lista"
          >
            <RefreshCw size={18} className={`${loading ? 'animate-spin' : 'group-hover:rotate-180 transition-transform duration-500'}`} />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6 space-y-3 custom-scrollbar">
          {error && (
            <div className="p-4 bg-red-500/10 border border-red-500/20 rounded-2xl text-red-400 text-sm mb-4 flex items-center gap-3">
              <span className="w-2 h-2 bg-red-500 rounded-full animate-pulse" />
              {error}
            </div>
          )}

          {loading && apps.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center space-y-4 opacity-50">
              <RefreshCw className="animate-spin text-blue-500" size={32} />
              <p className="text-sm font-mono text-blue-400 tracking-widest uppercase">Consultando Registro...</p>
            </div>
          ) : filteredApps.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center opacity-30">
              <Box size={48} className="mb-4" />
              <p className="text-lg">Nenhum aplicativo encontrado</p>
            </div>
          ) : (
            <div className="space-y-2">
              <div className="grid grid-cols-12 gap-4 px-4 py-2 text-[10px] font-mono text-gray-500 uppercase tracking-widest sticky top-0 bg-[#0f1115] z-10">
                <div className="col-span-6">Nome do Produto</div>
                <div className="col-span-2">Versão</div>
                <div className="col-span-3">Publicador</div>
                <div className="col-span-1"></div>
              </div>
              
              {filteredApps.map((app, idx) => (
                <div 
                  key={idx} 
                  className="grid grid-cols-12 gap-4 items-center p-4 bg-white/[0.02] border border-white/5 rounded-2xl hover:bg-white/[0.05] hover:border-white/10 transition-all group"
                >
                  <div className="col-span-6">
                    <p className="text-sm font-medium text-white truncate" title={app.Name}>{app.Name}</p>
                  </div>
                  <div className="col-span-2">
                    <span className="text-[10px] font-mono text-gray-500 bg-white/5 px-2 py-0.5 rounded-md border border-white/5">
                      {app.Version || '---'}
                    </span>
                  </div>
                  <div className="col-span-3">
                    <p className="text-xs text-gray-400 truncate">{app.Publisher || '---'}</p>
                  </div>
                  <div className="col-span-1 flex justify-end">
                    <button 
                      onClick={() => uninstallApp(app.Name)}
                      disabled={loading}
                      className="p-2 bg-red-500/10 text-red-500 rounded-xl opacity-0 group-hover:opacity-100 hover:bg-red-500 hover:text-white transition-all transform hover:scale-110 disabled:opacity-0"
                      title="Solicitar Desinstalação Remota"
                    >
                      <Trash size={16} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 bg-white/[0.02] border-t border-white/5 flex items-center justify-between text-[10px] text-gray-500 font-mono">
          <div className="flex items-center gap-4">
            <span className="flex items-center gap-1.5 text-blue-400/80">
              <span className="w-1.5 h-1.5 bg-blue-500 rounded-full animate-pulse" />
              Isolated Module V2.0
            </span>
            <span>Total: {apps.length} itens</span>
          </div>
          <div className="flex gap-4">
            <span>REGISTRY_QUERY: OK</span>
            <span>SMB_PROTOCOL: ACTIVE</span>
          </div>
        </div>
        
        {loading && (
          <div className="absolute bottom-0 left-0 h-0.5 bg-blue-500 shadow-[0_0_10px_#3b82f6] animate-[shimmer_2s_infinite]" style={{ width: '100%', backgroundSize: '200% 100%' }} />
        )}
      </div>
    </div>
  );
};
