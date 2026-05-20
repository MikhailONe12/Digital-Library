
import React, { useState, useMemo, useRef, useEffect } from 'react';
import { AppState, MediaItem, Locale, FileFormat, CustomType } from '../types';
import { 
  Plus, Edit2, Trash2, Users, Eye, Download, LogOut, Tags,
  ShieldCheck, X, AtSign, Unlock, Lock,
  Percent, Database, Upload,
  Ban, ShieldAlert, Monitor, MousePointer2, Trophy, BarChart4
} from 'lucide-react';
import { updateItem, deleteItem, saveDb, addUserToWhitelist, removeUserFromWhitelist, toggleGlobalAccess, addCustomType, deleteCustomType, updateCustomType, addToBlacklist, removeFromBlacklist, resetStats, loadAnalytics, getServerApiKey, setServerApiKey } from '../services/db';
import {
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  AreaChart, Area
} from 'recharts';
import { pickText } from '../utils';

interface AdminProps {
  onBack: () => void;
  db: AppState;
  onUpdate: () => void;
  onLogout: () => void;
  isAdmin: boolean;
  setIsAdmin: (val: boolean) => void;
  lang: Locale;
  t: any;
}

const Admin: React.FC<AdminProps> = ({ onBack, db, onUpdate, onLogout, isAdmin, setIsAdmin, lang, t }) => {
  const [apiKeyInput, setApiKeyInput] = useState('');
  // Removed 'users' from activeTab type as it is merged into security
  const [activeTab, setActiveTab] = useState<'stats' | 'items' | 'types' | 'data' | 'security'>('stats');
  const [editingItem, setEditingItem] = useState<Partial<MediaItem> | null>(null);
  const [newUserNickname, setNewUserNickname] = useState('');
  const [newBlacklistEntry, setNewBlacklistEntry] = useState('');
  const [newTypeLabels, setNewTypeLabels] = useState({ en: '', ru: '', es: '' });
  const typedLangsRef = useRef<Set<'en' | 'ru' | 'es'>>(new Set());
  const [editingType, setEditingType] = useState<CustomType | null>(null);
  const [importJson, setImportJson] = useState('');
  const [uploadState, setUploadState] = useState<{ field: string; progress: number } | null>(null);
  const [stagedCoverFile, setStagedCoverFile] = useState<File | null>(null);
  const [stagedContentFile, setStagedContentFile] = useState<{ file: File; formatId: string } | null>(null);
  const [serverApiKeyInput, setServerApiKeyInput] = useState(() => getServerApiKey());
  const [loginLoading, setLoginLoading] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const coverInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const uploadingFormatId = useRef<string | null>(null);

  // Auto-scroll menu to active item
  useEffect(() => {
    if (menuRef.current) {
        const activeBtn = menuRef.current.querySelector('[data-active="true"]');
        if (activeBtn) {
            activeBtn.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
        }
    }
  }, [activeTab]);

  // Pull traffic/engagement analytics from the DB once authorized
  useEffect(() => {
    if (isAdmin) {
      loadAnalytics().then(() => onUpdate());
    }
  }, [isAdmin]);

  // Analytics Computations
  const analytics = useMemo(() => {
    const totalViews = db.items.reduce((acc, i) => acc + i.views, 0);
    const totalDownloads = db.items.reduce((acc, i) => acc + i.downloads, 0);
    const conversionRate = totalViews > 0 ? ((totalDownloads / totalViews) * 100).toFixed(1) : 0;
    
    // Create copies before sorting to avoid mutating state directly (though db object is usually new)
    const topViews = [...db.items].sort((a, b) => b.views - a.views).slice(0, 5);
    const topDownloads = [...db.items].sort((a, b) => b.downloads - a.downloads).slice(0, 5);
    const topUsers = [...db.userAnalytics].sort((a, b) => (b.views + b.downloads) - (a.views + a.downloads)).slice(0, 10);

    return { totalViews, totalDownloads, conversionRate, topViews, topDownloads, topUsers };
  }, [db]);

  // Traffic & Security Analytics
  const trafficStats = useMemo(() => {
    const now = new Date();
    const oneDay = 24 * 60 * 60 * 1000;
    
    const logs = db.visitLogs || [];

    const getStatsForPeriod = (ms: number) => {
       const cutoff = now.getTime() - ms;
       const periodLogs = logs.filter(l => new Date(l.timestamp).getTime() >= cutoff);
       const uniqueVisitors = new Set(periodLogs.map(l => l.username && l.username !== 'guest' ? l.username : l.ip)).size;
       return { total: periodLogs.length, unique: uniqueVisitors };
    };

    return {
        day: getStatsForPeriod(oneDay),
        week: getStatsForPeriod(oneDay * 7),
        month: getStatsForPeriod(oneDay * 30),
        year: getStatsForPeriod(oneDay * 365)
    };
  }, [db.visitLogs]);

  const formatFileSize = (bytes: number) =>
    bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${(bytes / 1024).toFixed(0)} KB`;

  const uploadCover = (itemId: string) => {
    const file = stagedCoverFile;
    if (!file) return;
    const formData = new FormData();
    formData.append('file', file);
    const xhr = new XMLHttpRequest();
    setUploadState({ field: 'cover', progress: 0 });
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) setUploadState({ field: 'cover', progress: Math.round((e.loaded / e.total) * 100) });
    };
    xhr.onload = () => {
      setUploadState(null);
      setStagedCoverFile(null);
      if (coverInputRef.current) coverInputRef.current.value = '';
      if (xhr.status === 200) {
        const res = JSON.parse(xhr.responseText);
        setEditingItem(prev => prev ? { ...prev, coverUrl: res.url } : prev);
      } else {
        alert('Ошибка загрузки обложки: ' + xhr.status);
      }
    };
    xhr.onerror = () => { setUploadState(null); alert('Ошибка сети при загрузке'); };
    xhr.open('POST', `/api/upload/${itemId}/cover`);
    const key = getServerApiKey();
    if (key) xhr.setRequestHeader('x-api-key', key);
    xhr.send(formData);
  };

  const uploadContentFile = (itemId: string, formatId: string, lang: string) => {
    const file = stagedContentFile?.file;
    if (!file) return;
    const formData = new FormData();
    formData.append('lang', lang);
    formData.append('file', file);
    const xhr = new XMLHttpRequest();
    setUploadState({ field: formatId, progress: 0 });
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) setUploadState({ field: formatId, progress: Math.round((e.loaded / e.total) * 100) });
    };
    xhr.onload = () => {
      setUploadState(null);
      setStagedContentFile(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
      uploadingFormatId.current = null;
      if (xhr.status === 200) {
        const res = JSON.parse(xhr.responseText);
        setEditingItem(prev => {
          if (!prev) return prev;
          return { ...prev, formats: (prev.formats || []).map(f => f.id === formatId ? { ...f, url: res.url, size: res.size } : f) };
        });
      } else {
        alert('Ошибка загрузки файла: ' + xhr.status);
      }
    };
    xhr.onerror = () => { setUploadState(null); alert('Ошибка сети при загрузке'); };
    xhr.open('POST', `/api/upload/${itemId}/file`);
    const key = getServerApiKey();
    if (key) xhr.setRequestHeader('x-api-key', key);
    xhr.send(formData);
  };

  const handleSaveItem = () => {
    if (editingItem) {
      const hasTitle = editingItem.title && (editingItem.title.en || editingItem.title.ru || editingItem.title.es);
      if (!hasTitle) {
        alert('Please provide a title in at least one language.');
        return;
      }

      const itemToSave = {
        ...editingItem,
        id: editingItem.id || Date.now().toString(),
        rating: editingItem.rating || 0,
        author: editingItem.author || 'Anonymous',
        publishedDate: editingItem.publishedDate || new Date().toISOString().split('T')[0],
        addedDate: editingItem.addedDate || new Date().toISOString(),
        views: editingItem.views || 0,
        downloads: editingItem.downloads || 0,
        formats: (editingItem.formats || []).map(f => ({
          ...f,
          allowDownload: f.allowDownload !== undefined ? f.allowDownload : true,
          allowReading: f.allowReading !== undefined ? f.allowReading : true,
        })),
        contentLanguages: editingItem.contentLanguages || ['en'],
        allowDownload: editingItem.allowDownload !== undefined ? editingItem.allowDownload : true,
        allowReading: editingItem.allowReading !== undefined ? editingItem.allowReading : true
      } as MediaItem;

      updateItem(itemToSave);
      onUpdate();
      setEditingItem(null);
    }
  };

  const handleToggleContentLang = (l: Locale) => {
    if (!editingItem) return;
    const current = editingItem.contentLanguages || [];
    const updated = current.includes(l) 
      ? current.filter(item => item !== l)
      : [...current, l];
    
    if (updated.length > 0) {
      setEditingItem({ ...editingItem, contentLanguages: updated });
    }
  };

  const handleAddFormat = () => {
    if (editingItem) {
      const newFormat: FileFormat = { 
        id: Date.now().toString(), 
        name: 'New File', 
        url: '', 
        size: '0MB', 
        language: 'en',
        allowDownload: true,
        allowReading: true
      };
      setEditingItem({
        ...editingItem,
        formats: [...(editingItem.formats || []), newFormat]
      });
    }
  };

  const handleUpdateFormat = (id: string, field: keyof FileFormat, value: any) => {
    if (editingItem && editingItem.formats) {
      const updated = editingItem.formats.map(f => f.id === id ? { ...f, [field]: value } : f);
      setEditingItem({ ...editingItem, formats: updated });
    }
  };

  const handleRemoveFormat = (id: string) => {
    if (editingItem && editingItem.formats) {
      setEditingItem({ ...editingItem, formats: editingItem.formats.filter(f => f.id !== id) });
    }
  };

  const handleDeleteFormat = async (f: FileFormat) => {
    if (!editingItem?.id) return;
    if (!confirm(`Удалить файл "${f.name}" с сервера? Это действие нельзя отменить.`)) return;
    const filename = f.url ? f.url.split('/').pop() : null;
    if (filename) {
      const key = getServerApiKey();
      try {
        const res = await fetch(`/api/upload/${editingItem.id}/${filename}`, {
          method: 'DELETE',
          headers: key ? { 'x-api-key': key } : {},
        });
        if (!res.ok) {
          alert('Ошибка при удалении файла с сервера: ' + res.status);
          return;
        }
      } catch {
        alert('Ошибка сети при удалении файла');
        return;
      }
    }
    handleRemoveFormat(f.id);
  };

  const handleAddUser = () => {
    if (newUserNickname.trim()) {
      addUserToWhitelist(newUserNickname.toLowerCase());
      setNewUserNickname('');
      onUpdate();
    }
  };

  const handleRemoveUser = (username: string) => {
    if (confirm(`Remove ${username} from whitelist?`)) {
      removeUserFromWhitelist(username);
      onUpdate();
    }
  };

  const handleAddBlacklist = () => {
    if (newBlacklistEntry.trim()) {
      addToBlacklist(newBlacklistEntry);
      setNewBlacklistEntry('');
      onUpdate();
    }
  };

  const handleRemoveBlacklist = (entry: string) => {
    removeFromBlacklist(entry);
    onUpdate();
  };

  const handleAddType = () => {
    const { en, ru, es } = newTypeLabels;
    if (!en.trim() && !ru.trim() && !es.trim()) return;
    const base = (en || ru || es).trim();
    const id = base.normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 20) || 'CAT_' + Date.now().toString(36).slice(-5).toUpperCase();
    addCustomType({
      id,
      en: en.trim() || ru.trim() || es.trim(),
      ru: ru.trim() || en.trim() || es.trim(),
      es: es.trim() || en.trim() || ru.trim(),
    });
    setNewTypeLabels({ en: '', ru: '', es: '' });
    typedLangsRef.current.clear();
    onUpdate();
  };

  const handleDeleteType = (id: string) => {
    if (confirm('Удалить раздел? Элементы с этим типом сохранят своё значение.')) {
      deleteCustomType(id);
      setEditingType(null);
      onUpdate();
    }
  };

  const handleSaveType = () => {
    if (!editingType) return;
    updateCustomType(editingType.id, { en: editingType.en, ru: editingType.ru, es: editingType.es });
    setEditingType(null);
    onUpdate();
  };

  const handleToggleGlobal = (e: React.ChangeEvent<HTMLInputElement>) => {
    toggleGlobalAccess(e.target.checked);
    onUpdate();
  };

  const handleImportJson = () => {
    try {
      if (!importJson.trim()) return;
      const parsed = JSON.parse(importJson);
      if (!parsed.items || !Array.isArray(parsed.items)) {
        throw new Error('Invalid Database Format');
      }
      if(confirm('WARNING: This will overwrite all current app data. Continue?')) {
        saveDb(parsed);
        onUpdate();
        setImportJson('');
        alert('Database imported!');
      }
    } catch (e) {
      alert('Error parsing JSON.');
    }
  };

  const handleResetStats = async () => {
    if (confirm('Сбросить всю статистику? Просмотры, скачивания и данные пользователей обнулятся. Отменить нельзя.')) {
      await resetStats();
      await loadAnalytics();
      onUpdate();
    }
  };

  const handleAdminLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoginLoading(true);
    try {
      const res = await fetch('/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: apiKeyInput }),
      });
      if (!res.ok) {
        alert('Invalid Access Token');
        return;
      }
      const { apiKey } = await res.json();
      setServerApiKey(apiKey);
      setServerApiKeyInput(apiKey);
      setIsAdmin(true);
    } catch {
      alert('Connection error. Check your network.');
    } finally {
      setLoginLoading(false);
    }
  };

  if (!isAdmin) {
    return (
      <div className="min-h-screen flex items-center justify-center px-6 bg-slate-50">
        <div className="w-full max-w-md bg-white/80 backdrop-blur-2xl border border-slate-200 p-8 md:p-12 rounded-[2rem] md:rounded-[3rem] shadow-[0_25px_60px_rgba(0,0,0,0.1)] relative">
          <div className="absolute -top-8 left-1/2 -translate-x-1/2 bg-red-600 w-16 h-16 rounded-2xl flex items-center justify-center shadow-2xl shadow-red-200">
              <ShieldCheck size={32} className="text-white" />
          </div>
          <h2 className="text-xl md:text-2xl font-black text-center mb-2 mt-8 tracking-tighter uppercase text-slate-900">{t.adminAccess}</h2>
          <p className="text-slate-400 text-center mb-8 text-[10px] font-black uppercase tracking-[0.2em]">Authorized Personnel Only</p>
          <form onSubmit={handleAdminLogin} className="space-y-4">
            <div className="space-y-1">
                <label className="text-[9px] font-black uppercase tracking-widest text-slate-400 ml-2">{t.apiKey}</label>
                <input
                    type="password"
                    placeholder="••••••••"
                    className="w-full bg-slate-50 border border-slate-200 rounded-2xl py-4 px-6 focus:ring-4 focus:ring-red-500/5 focus:border-red-600 outline-none transition-all font-mono text-sm"
                    value={apiKeyInput} onChange={e => setApiKeyInput(e.target.value)}
                />
            </div>
            <button disabled={loginLoading} className="w-full bg-red-600 py-4 rounded-[2rem] font-black text-white uppercase tracking-widest shadow-xl shadow-red-200 transition-all active:scale-95 hover:bg-red-700 text-xs disabled:opacity-60">
                {loginLoading ? '...' : t.accessDashboard}
            </button>
            <button type="button" onClick={onBack} className="w-full text-slate-400 font-black text-[9px] uppercase tracking-[0.3em] hover:text-red-600 transition-colors py-2">
                {t.back}
            </button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div
      className="p-4 md:p-6 animate-in fade-in min-h-screen pb-24 max-w-7xl mx-auto"
      style={{ paddingTop: 'calc(3.5rem + var(--safe-top))' }}
    >
      <header className="flex items-center justify-between mb-6 md:mb-10">
        <div>
          <h1 className="text-2xl md:text-3xl font-black text-slate-900 tracking-tighter uppercase leading-none mb-1">Control<span className="text-red-600">Center</span></h1>
          <p className="text-[8px] md:text-[9px] font-black text-slate-400 uppercase tracking-[0.4em]">{t.adminTerminal}</p>
        </div>
        <button onClick={onLogout} className="p-3 md:p-4 bg-white rounded-2xl text-red-600 border border-slate-200 shadow-sm active:scale-95 transition-all">
            <LogOut size={20} strokeWidth={3} />
        </button>
      </header>

      {/* Optimized Navigation Menu (Horizontal Scroll) */}
      <div className="mb-8 md:mb-10 w-full relative group">
         <div 
           className="flex gap-2 overflow-x-auto no-scrollbar pb-2 px-1 snap-x scroll-smooth"
           ref={menuRef}
         >
          {/* REMOVED 'users' from list */}
          {(['stats', 'security', 'items', 'types', 'data'] as const).map(tab => (
            <button 
              key={tab} 
              data-active={activeTab === tab}
              onClick={() => setActiveTab(tab)} 
              className={`
                flex-shrink-0 snap-start px-5 py-2.5 rounded-2xl text-[10px] md:text-xs font-black uppercase tracking-widest transition-all duration-300 border whitespace-nowrap
                ${activeTab === tab 
                  ? 'bg-red-600 border-red-600 text-white shadow-lg shadow-red-200' 
                  : 'bg-white border-slate-200 text-slate-400 hover:border-red-200 hover:text-red-600'
                }
              `}
            >
              {t[tab] || tab}
            </button>
          ))}
         </div>
         <div className="absolute right-0 top-0 bottom-2 w-12 bg-gradient-to-l from-[#f8fafc] to-transparent pointer-events-none md:hidden" />
      </div>

      <div className="max-w-7xl mx-auto">
        {activeTab === 'security' && (
          <div className="space-y-6 md:space-y-8 animate-in slide-in-from-bottom-4 duration-500">
             
            {/* 1. Global Access Control (Moved from Users) */}
            <div className="bg-white p-5 md:p-8 rounded-[2rem] border border-slate-100 shadow-sm">
                <h3 className="text-xs md:text-sm font-black mb-6 flex items-center gap-3 text-slate-900 uppercase tracking-widest underline decoration-red-600 decoration-4 underline-offset-8">
                   {t.publicAccessControl}
                </h3>
                <div className="flex items-center justify-between">
                   <div className="flex items-center gap-4">
                      <div className={`p-3 rounded-2xl ${db.globalAccess ? 'bg-green-50 text-green-600' : 'bg-red-50 text-red-600'}`}>
                         {db.globalAccess ? <Unlock size={20} /> : <Lock size={20} />}
                      </div>
                      <div>
                         <h3 className="text-xs font-black uppercase tracking-widest">{t.globalStatus}</h3>
                         <p className="text-[8px] font-black text-slate-400 uppercase">{db.globalAccess ? 'Open to Public' : 'Whitelist Only'}</p>
                      </div>
                   </div>
                   <label className="relative inline-flex items-center cursor-pointer">
                      <input type="checkbox" className="sr-only peer" checked={db.globalAccess} onChange={handleToggleGlobal} />
                      <div className="w-12 h-7 bg-slate-200 peer-focus:outline-none rounded-full peer peer-checked:bg-red-600 transition-all after:content-[''] after:absolute after:top-[4px] after:left-[4px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:after:translate-x-full"></div>
                   </label>
                </div>
            </div>

            {/* 2. Whitelist Management (Moved from Users) */}
            <div className="bg-white p-5 md:p-8 rounded-[2rem] border border-slate-100 shadow-sm">
                 <h3 className="text-xs md:text-sm font-black mb-6 flex items-center gap-3 text-slate-900 uppercase tracking-widest underline decoration-red-600 decoration-4 underline-offset-8">
                   {t.users} (Whitelist)
                 </h3>
                 <div className="flex gap-2 mb-6">
                    <input 
                      type="text" placeholder="Telegram Username" className="flex-1 bg-slate-50 border border-slate-100 rounded-2xl px-4 py-3 text-xs font-black uppercase focus:border-red-600 outline-none"
                      value={newUserNickname} onChange={e => setNewUserNickname(e.target.value)}
                    />
                    <button onClick={handleAddUser} className="bg-red-600 text-white px-6 rounded-2xl font-black uppercase text-[10px] tracking-widest hover:bg-red-700 transition-colors">Add</button>
                 </div>
                 
                 <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                    {db.allowedUsers.length > 0 ? db.allowedUsers.map(u => (
                       <div key={u} className="flex justify-between items-center p-3 bg-slate-50 rounded-2xl border border-slate-100 group hover:border-red-100 transition-all">
                          <div className="flex items-center gap-2">
                             <div className="bg-white p-1.5 rounded-lg text-slate-400"><Users size={12}/></div>
                             <span className="text-xs font-bold text-slate-700">@{u}</span>
                          </div>
                          <button onClick={() => handleRemoveUser(u)} className="p-2 bg-white rounded-xl text-slate-300 hover:text-red-600 transition-colors"><Trash2 size={14} /></button>
                       </div>
                    )) : (
                        <p className="text-[10px] uppercase font-black text-slate-400 col-span-2 text-center py-4">Whitelist is empty</p>
                    )}
                 </div>
            </div>

            {/* 3. Blacklist Management */}
            <div className="bg-white p-5 md:p-8 rounded-[2rem] border border-slate-100 shadow-sm">
                  <h3 className="text-xs md:text-sm font-black mb-6 flex items-center gap-3 text-red-600 uppercase tracking-widest underline decoration-red-200 decoration-4 underline-offset-8">
                      <Ban size={18} /> {t.blacklist}
                  </h3>
                  
                  <div className="flex gap-2 md:gap-3 mb-6 md:mb-8">
                      <div className="relative flex-1">
                          <ShieldAlert className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" size={16} />
                          <input 
                          type="text" 
                          placeholder="@username / IP" 
                          className="w-full bg-slate-50 border border-slate-100 rounded-2xl pl-10 pr-4 py-3 md:py-4 text-xs font-black uppercase tracking-widest focus:ring-2 focus:ring-red-600/10 focus:border-red-600 outline-none transition-all"
                          value={newBlacklistEntry}
                          onChange={(e) => setNewBlacklistEntry(e.target.value)}
                          />
                      </div>
                      <button 
                          onClick={handleAddBlacklist}
                          className="bg-slate-900 px-4 md:px-6 py-3 md:py-4 rounded-2xl font-black text-white text-[10px] uppercase tracking-widest shadow-lg active:scale-95 transition-all"
                      >
                          {t.block}
                      </button>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      {db.blacklist && db.blacklist.map(entry => (
                          <div key={entry} className="flex items-center justify-between p-3 md:p-4 bg-red-50 border border-red-100 rounded-2xl group hover:shadow-md transition-all">
                              <div className="flex items-center gap-3 truncate">
                                  <Ban size={16} className="text-red-600 shrink-0" />
                                  <span className="text-xs font-black text-red-900 truncate">{entry}</span>
                              </div>
                              <button 
                                  onClick={() => handleRemoveBlacklist(entry)}
                                  className="px-3 py-1.5 bg-white text-red-600 text-[9px] font-bold uppercase rounded-lg shadow-sm hover:bg-red-600 hover:text-white transition-colors shrink-0"
                              >
                                  {t.unblock}
                              </button>
                          </div>
                      ))}
                      {(!db.blacklist || db.blacklist.length === 0) && (
                          <p className="col-span-2 text-center text-[10px] text-slate-400 font-bold uppercase py-6">Blacklist is empty</p>
                      )}
                  </div>
            </div>

            {/* 4. Access Logs */}
            <div className="bg-white p-5 md:p-8 rounded-[2rem] border border-slate-100 shadow-sm overflow-hidden">
                <h3 className="text-[10px] font-black uppercase tracking-widest text-slate-900 mb-6 flex items-center gap-2">
                      <Monitor size={14} className="text-blue-600" /> {t.accessLogs}
                </h3>
                <div className="overflow-x-auto">
                    <table className="w-full text-left border-collapse min-w-[500px]">
                        <thead>
                            <tr className="border-b border-slate-100">
                                <th className="p-3 text-[9px] font-black uppercase text-slate-400 tracking-widest">Time</th>
                                <th className="p-3 text-[9px] font-black uppercase text-slate-400 tracking-widest">User</th>
                                <th className="p-3 text-[9px] font-black uppercase text-slate-400 tracking-widest">{t.ipAddress}</th>
                                <th className="p-3 text-[9px] font-black uppercase text-slate-400 tracking-widest text-right">{t.device}</th>
                            </tr>
                        </thead>
                        <tbody className="text-[10px] font-mono">
                            {db.visitLogs && db.visitLogs.slice(0, 50).map(log => (
                                <tr key={log.id} className="border-b border-slate-50 hover:bg-slate-50 transition-colors">
                                    <td className="p-3 text-slate-400 whitespace-nowrap">{new Date(log.timestamp).toLocaleTimeString()}</td>
                                    <td className="p-3 font-bold text-slate-700">{log.username}</td>
                                    <td className="p-3 text-slate-500">{log.ip}</td>
                                    <td className="p-3 text-right text-slate-400 truncate max-w-[150px]">{log.platform}</td>
                                </tr>
                            ))}
                            {(!db.visitLogs || db.visitLogs.length === 0) && (
                                <tr><td colSpan={4} className="p-8 text-center text-slate-400">No logs yet</td></tr>
                            )}
                        </tbody>
                    </table>
                </div>
            </div>
          </div>
        )}

        {activeTab === 'stats' && (
          <div className="space-y-6 md:space-y-8 animate-in slide-in-from-bottom-4 duration-500">
            {/* Summary Cards */}
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3 md:gap-6">
              <div className="bg-white p-4 md:p-6 rounded-[2rem] border border-slate-100 shadow-sm relative overflow-hidden group">
                <div className="relative z-10">
                  <p className="text-[8px] md:text-[9px] font-black text-slate-400 uppercase tracking-widest mb-1">{t.totalViews}</p>
                  <p className="text-2xl md:text-4xl font-black text-slate-900 tracking-tighter">{analytics.totalViews}</p>
                </div>
                <Eye className="absolute -right-2 -bottom-2 text-slate-50 opacity-50 md:opacity-100 group-hover:text-red-50 transition-colors" size={60} />
              </div>
              <div className="bg-white p-4 md:p-6 rounded-[2rem] border border-slate-100 shadow-sm relative overflow-hidden group">
                <div className="relative z-10">
                  <p className="text-[8px] md:text-[9px] font-black text-slate-400 uppercase tracking-widest mb-1">{t.totalDownloads}</p>
                  <p className="text-2xl md:text-4xl font-black text-slate-900 tracking-tighter">{analytics.totalDownloads}</p>
                </div>
                <Download className="absolute -right-2 -bottom-2 text-slate-50 opacity-50 md:opacity-100 group-hover:text-green-50 transition-colors" size={60} />
              </div>
              <div className="bg-white p-4 md:p-6 rounded-[2rem] border border-slate-100 shadow-sm relative overflow-hidden group col-span-2 md:col-span-1">
                <div className="relative z-10">
                  <p className="text-[8px] md:text-[9px] font-black text-slate-400 uppercase tracking-widest mb-1">{t.conversion}</p>
                  <p className="text-2xl md:text-4xl font-black text-slate-900 tracking-tighter">{analytics.conversionRate}%</p>
                </div>
                <Percent className="absolute -right-2 -bottom-2 text-slate-50 opacity-50 md:opacity-100 group-hover:text-blue-50 transition-colors" size={60} />
              </div>
            </div>

            {/* Engagement Graph */}
            <div className="bg-white p-5 md:p-8 rounded-[2rem] border border-slate-100 shadow-sm">
               <div className="flex items-center justify-between mb-4">
                  <h3 className="text-[10px] font-black uppercase tracking-widest text-slate-900 flex items-center gap-2">
                     <BarChart4 size={14} className="text-slate-400"/> Activity Timeline
                  </h3>
               </div>
              <div className="h-48 md:h-64 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={db.stats}>
                    <defs>
                      <linearGradient id="colorViews" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#dc2626" stopOpacity={0.3}/>
                        <stop offset="95%" stopColor="#dc2626" stopOpacity={0}/>
                      </linearGradient>
                      <linearGradient id="colorDownloads" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#22c55e" stopOpacity={0.3}/>
                        <stop offset="95%" stopColor="#22c55e" stopOpacity={0}/>
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
                    <XAxis dataKey="date" axisLine={false} tickLine={false} tick={{fontSize: 9, fontWeight: 900, fill: '#94a3b8'}} dy={10} />
                    <YAxis axisLine={false} tickLine={false} tick={{fontSize: 9, fontWeight: 900, fill: '#94a3b8'}} />
                    <Tooltip contentStyle={{ borderRadius: '16px', border: 'none', boxShadow: '0 10px 30px rgba(0,0,0,0.1)', fontSize: '10px', fontWeight: 800 }} />
                    <Area type="monotone" dataKey="views" stroke="#dc2626" strokeWidth={3} fillOpacity={1} fill="url(#colorViews)" />
                    <Area type="monotone" dataKey="downloads" stroke="#22c55e" strokeWidth={3} fillOpacity={1} fill="url(#colorDownloads)" />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </div>

            {/* NEW: Content Intelligence (Restored) */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 md:gap-8">
                {/* Hot Assets (Views) */}
                <div className="bg-white p-5 md:p-8 rounded-[2rem] border border-slate-100 shadow-sm">
                    <h3 className="text-[10px] font-black uppercase tracking-widest text-slate-900 mb-6 flex items-center gap-2">
                        <Eye size={14} className="text-red-600" /> {t.hotAssets}
                    </h3>
                    <div className="space-y-3">
                        {analytics.topViews.map((item, idx) => (
                        <div key={item.id} className="flex items-center justify-between p-3 bg-slate-50 rounded-2xl border border-slate-100 hover:border-red-100 transition-all group">
                            <div className="flex items-center gap-3 overflow-hidden">
                                <span className="text-[10px] font-black text-slate-300 shrink-0">#{idx + 1}</span>
                                <div className="w-8 h-10 rounded-md overflow-hidden shrink-0">
                                   <img src={item.coverUrl} className="w-full h-full object-cover" alt="" />
                                </div>
                                <div className="min-w-0">
                                    <p className="text-xs font-black text-slate-900 tracking-tight group-hover:text-red-600 truncate">{pickText(item.title, lang)}</p>
                                    <p className="text-[8px] font-black text-slate-400 uppercase">{item.type}</p>
                                </div>
                            </div>
                            <div className="text-right shrink-0">
                                <p className="text-sm font-black text-slate-900">{item.views}</p>
                                <p className="text-[8px] font-black text-slate-400 uppercase">Hits</p>
                            </div>
                        </div>
                        ))}
                         {analytics.topViews.length === 0 && <p className="text-center text-xs text-slate-300 font-bold uppercase py-4">No data</p>}
                    </div>
                </div>

                {/* High Utility (Downloads) */}
                <div className="bg-white p-5 md:p-8 rounded-[2rem] border border-slate-100 shadow-sm">
                    <h3 className="text-[10px] font-black uppercase tracking-widest text-slate-900 mb-6 flex items-center gap-2">
                        <Download size={14} className="text-green-600" /> {t.highUtility}
                    </h3>
                    <div className="space-y-3">
                        {analytics.topDownloads.map((item, idx) => (
                        <div key={item.id} className="flex items-center justify-between p-3 bg-slate-50 rounded-2xl border border-slate-100 hover:border-green-100 transition-all group">
                            <div className="flex items-center gap-3 overflow-hidden">
                                <span className="text-[10px] font-black text-slate-300 shrink-0">#{idx + 1}</span>
                                <div className="w-8 h-10 rounded-md overflow-hidden shrink-0">
                                   <img src={item.coverUrl} className="w-full h-full object-cover" alt="" />
                                </div>
                                <div className="min-w-0">
                                    <p className="text-xs font-black text-slate-900 tracking-tight group-hover:text-green-600 truncate">{pickText(item.title, lang)}</p>
                                    <p className="text-[8px] font-black text-slate-400 uppercase">{item.type}</p>
                                </div>
                            </div>
                            <div className="text-right shrink-0">
                                <p className="text-sm font-black text-slate-900">{item.downloads}</p>
                                <p className="text-[8px] font-black text-slate-400 uppercase">Files</p>
                            </div>
                        </div>
                        ))}
                        {analytics.topDownloads.length === 0 && <p className="text-center text-xs text-slate-300 font-bold uppercase py-4">No data</p>}
                    </div>
                </div>
            </div>

            {/* NEW: User Leaderboard (Restored) */}
            <div className="bg-white p-5 md:p-8 rounded-[2rem] border border-slate-100 shadow-sm">
                <h3 className="text-[10px] font-black uppercase tracking-widest text-slate-900 mb-6 flex items-center gap-2">
                    <Trophy size={14} className="text-yellow-500" /> {t.userLeaderboard}
                </h3>
                <div className="overflow-x-auto">
                    <table className="w-full text-left border-collapse min-w-[300px]">
                        <thead>
                            <tr className="border-b border-slate-100">
                                <th className="p-3 text-[8px] font-black uppercase text-slate-400 tracking-widest">Ранг</th>
                                <th className="p-3 text-[8px] font-black uppercase text-slate-400 tracking-widest">Пользователь</th>
                                <th className="p-3 text-[8px] font-black uppercase text-slate-400 tracking-widest">Интересы</th>
                                <th className="p-3 text-[8px] font-black uppercase text-slate-400 tracking-widest text-right">Активность</th>
                            </tr>
                        </thead>
                        <tbody>
                            {analytics.topUsers.length > 0 ? analytics.topUsers.map((user, idx) => {
                                const topTypes = Object.entries(user.itemViews || {})
                                  .sort((a, b) => b[1] - a[1])
                                  .slice(0, 3)
                                  .map(([itemId]) => db.items.find(i => i.id === itemId)?.type)
                                  .filter(Boolean);
                                const uniqueTypes = [...new Set(topTypes)];
                                return (
                                <tr key={user.username} className="border-b border-slate-50 hover:bg-slate-50 transition-colors group">
                                    <td className="p-3 text-[10px] font-black text-slate-300">#{idx + 1}</td>
                                    <td className="p-3">
                                        <div className="flex items-center gap-2">
                                            <div className="w-6 h-6 rounded-full bg-slate-100 flex items-center justify-center text-slate-500 font-bold uppercase text-[8px]">
                                                {user.username.slice(0, 2)}
                                            </div>
                                            <div>
                                                <p className="text-[10px] font-bold text-slate-700 group-hover:text-blue-600 transition-colors">@{user.username}</p>
                                                <p className="text-[8px] text-slate-400">{user.lastActive}</p>
                                            </div>
                                        </div>
                                    </td>
                                    <td className="p-3">
                                        <div className="flex flex-wrap gap-1">
                                            {uniqueTypes.length > 0 ? uniqueTypes.map(type => (
                                                <span key={type} className="text-[7px] font-black uppercase bg-red-50 text-red-600 px-1.5 py-0.5 rounded">{type}</span>
                                            )) : <span className="text-[8px] text-slate-300">—</span>}
                                        </div>
                                    </td>
                                    <td className="p-3 text-right">
                                        <p className="text-xs font-black text-slate-900">{user.views + user.downloads}</p>
                                        <p className="text-[8px] text-slate-400">{user.views}👁 {user.downloads}⬇</p>
                                    </td>
                                </tr>
                                );
                            }) : (
                                <tr><td colSpan={4} className="p-8 text-center text-xs text-slate-400 font-bold uppercase tracking-widest">Нет данных о пользователях</td></tr>
                            )}
                        </tbody>
                    </table>
                </div>
            </div>

            {/* Traffic Analytics Block */}
            <div className="bg-white p-5 md:p-8 rounded-[2rem] border border-slate-100 shadow-sm">
                <h3 className="text-xs md:text-sm font-black mb-6 flex items-center gap-3 text-slate-900 uppercase tracking-widest underline decoration-red-600 decoration-4 underline-offset-8">
                  {t.trafficAnalytics}
                </h3>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3 md:gap-4">
                   {(['day', 'week', 'month', 'year'] as const).map(period => (
                       <div key={period} className="p-4 md:p-5 bg-slate-50 rounded-2xl border border-slate-100 relative overflow-hidden">
                          <p className="text-[8px] md:text-[9px] font-black text-slate-400 uppercase tracking-widest mb-2">{t[period]}</p>
                          <div className="flex justify-between items-end relative z-10">
                              <div>
                                  <p className="text-lg md:text-2xl font-black text-slate-900">{trafficStats[period].total}</p>
                                  <p className="text-[7px] md:text-[8px] font-bold text-slate-400 uppercase tracking-wider">{t.totalVisits}</p>
                              </div>
                              <div className="text-right">
                                  <p className="text-base md:text-xl font-black text-blue-600">{trafficStats[period].unique}</p>
                                  <p className="text-[7px] md:text-[8px] font-bold text-blue-300 uppercase tracking-wider">{t.uniqueVisitors}</p>
                              </div>
                          </div>
                       </div>
                   ))}
                </div>
            </div>
          </div>
        )}

        {activeTab === 'data' && (
          <div className="space-y-6 md:space-y-8 animate-in slide-in-from-bottom-4 duration-500">
            <div className="bg-white p-5 md:p-8 rounded-[2rem] border border-slate-100 shadow-sm">
              <div className="flex items-center gap-4 mb-6">
                  <div className="p-3 bg-red-50 text-red-600 rounded-2xl">
                      <Database size={24} />
                  </div>
                  <div>
                      <h3 className="text-sm font-black text-slate-900 uppercase tracking-widest">Database</h3>
                      <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest mt-1">Backup & Restore</p>
                  </div>
              </div>
              <div className="space-y-6">
                  <div className="p-5 md:p-6 bg-slate-50 rounded-3xl border border-slate-100">
                      <h4 className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-1 flex items-center gap-2">
                          <Upload size={14} /> Server API Key
                      </h4>
                      <p className="text-[9px] text-slate-400 font-bold mb-3">Нужен для загрузки файлов на сервер. Тот же что в .env (API_KEY).</p>
                      <div className="flex gap-2">
                        <input
                          type="password"
                          className="flex-1 bg-white border border-slate-200 rounded-2xl px-4 py-3 text-xs font-mono focus:border-red-600 outline-none"
                          placeholder="API_KEY из .env"
                          value={serverApiKeyInput}
                          onChange={e => setServerApiKeyInput(e.target.value)}
                        />
                        <button
                          onClick={() => { setServerApiKey(serverApiKeyInput); alert('API Key сохранён'); }}
                          className="px-5 bg-slate-900 text-white rounded-2xl text-[10px] font-black uppercase tracking-widest shrink-0"
                        >
                          Сохранить
                        </button>
                      </div>
                  </div>
                  <div className="p-5 md:p-6 bg-red-50 rounded-3xl border border-red-100">
                      <h4 className="text-[10px] font-black text-red-500 uppercase tracking-widest mb-3 flex items-center gap-2">
                          <BarChart4 size={14} /> Сбросить статистику
                      </h4>
                      <p className="text-[9px] text-slate-400 font-bold mb-4">Обнуляет просмотры, скачивания и данные пользователей. Сам контент не удаляется.</p>
                      <button onClick={handleResetStats} className="w-full py-4 bg-red-600 text-white rounded-2xl text-xs font-black uppercase tracking-widest shadow-md active:scale-95 transition-all hover:bg-red-700">
                          Сбросить всю статистику
                      </button>
                  </div>

                  <div className="p-5 md:p-6 bg-slate-50 rounded-3xl border border-slate-100">
                      <h4 className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-3 flex items-center gap-2">
                          <Upload size={14} /> Import Data
                      </h4>
                      <textarea 
                          className="w-full h-32 bg-white border border-slate-200 rounded-2xl p-4 text-[10px] font-mono mb-4 focus:border-red-600 outline-none"
                          placeholder='Paste JSON here...'
                          value={importJson}
                          onChange={e => setImportJson(e.target.value)}
                      />
                      <button onClick={handleImportJson} className="w-full py-4 bg-slate-900 text-white rounded-2xl text-xs font-black uppercase tracking-widest shadow-xl active:scale-95 transition-all">
                          Overwrite Database
                      </button>
                  </div>
              </div>
            </div>
          </div>
        )}


        {activeTab === 'items' && (
           <div className="space-y-6">
               <button 
                  onClick={() => setEditingItem({ id: Date.now().toString(), type: db.customTypes[0]?.id || 'BOOK', isPrivate: false, formats: [], title: {en:'',ru:'',es:''}, description: {en:'',ru:'',es:''}, author: '', publishedDate: new Date().toISOString().split('T')[0], contentLanguages: ['en'], allowDownload: true, allowReading: true })}
                  className="w-full py-4 bg-red-600 text-white rounded-[2rem] font-black uppercase tracking-[0.3em] text-xs shadow-xl shadow-red-200 flex items-center justify-center gap-2"
               >
                  <Plus size={18} /> {t.addContent}
               </button>
               <div className="space-y-3">
                  {db.items.map(i => (
                     <div key={i.id} className="bg-white p-4 rounded-[2rem] border border-slate-100 flex items-center justify-between shadow-sm">
                        <div className="flex items-center gap-4 overflow-hidden">
                           <img src={i.coverUrl} className="w-12 h-12 rounded-xl object-cover" />
                           <div className="min-w-0">
                              <h4 className="text-xs font-black text-slate-900 truncate">{pickText(i.title, lang)}</h4>
                              <span className="text-[8px] font-black text-slate-400 uppercase tracking-widest">{i.type}</span>
                           </div>
                        </div>
                        <div className="flex gap-2">
                           <button onClick={() => setEditingItem(i)} className="p-2 bg-slate-50 rounded-xl hover:bg-red-50 hover:text-red-600"><Edit2 size={16}/></button>
                           <button onClick={async () => { if(confirm('Delete?')) { const key = getServerApiKey(); try { await fetch(`/api/upload/${i.id}`, { method: 'DELETE', headers: key ? { 'x-api-key': key } : {} }); } catch {} deleteItem(i.id); onUpdate(); } }} className="p-2 bg-slate-50 rounded-xl hover:bg-red-50 hover:text-red-600"><Trash2 size={16}/></button>
                        </div>
                     </div>
                  ))}
               </div>
           </div>
        )}
        
        {activeTab === 'types' && (
          <div className="bg-white p-5 md:p-8 rounded-[2rem] border border-slate-100 shadow-sm">
            <h3 className="text-xs md:text-sm font-black mb-6 flex items-center gap-3 text-slate-900 uppercase tracking-widest underline decoration-red-600 decoration-4 underline-offset-8">{t.types}</h3>

            {/* Add new category */}
            <div className="p-4 bg-slate-50 rounded-2xl border border-slate-100 mb-6 space-y-3">
              <p className="text-[8px] font-black uppercase text-red-600 tracking-widest">{t.addCategory}</p>
              <div className="grid grid-cols-3 gap-2">
                {(['ru', 'en', 'es'] as const).map(l => (
                  <div key={l}>
                    <label className="text-[8px] font-black uppercase text-slate-400 ml-1">{l.toUpperCase()}</label>
                    <input
                      type="text"
                      className="w-full bg-white border border-slate-100 rounded-xl px-3 py-2 text-xs font-bold focus:border-red-600 outline-none"
                      value={newTypeLabels[l]}
                      onChange={e => {
                        const val = e.target.value;
                        typedLangsRef.current.add(l);
                        setNewTypeLabels(prev => {
                          const next = { ...prev, [l]: val };
                          (['en', 'ru', 'es'] as const).forEach(other => {
                            if (other !== l && !typedLangsRef.current.has(other)) next[other] = val;
                          });
                          return next;
                        });
                      }}
                    />
                  </div>
                ))}
              </div>
              <button onClick={handleAddType} className="w-full bg-red-600 text-white py-2.5 rounded-2xl font-black uppercase text-[10px] tracking-widest">
                + {t.addCategory}
              </button>
            </div>

            {/* Existing categories */}
            <div className="space-y-2">
              {db.customTypes.map(type => (
                editingType?.id === type.id ? (
                  <div key={type.id} className="p-4 bg-red-50 rounded-2xl border border-red-100 space-y-3">
                    <p className="text-[8px] font-black uppercase text-red-600 tracking-widest">Редактировать раздел</p>
                    <div className="grid grid-cols-3 gap-2">
                      {(['ru', 'en', 'es'] as const).map(l => (
                        <div key={l}>
                          <label className="text-[8px] font-black uppercase text-slate-400 ml-1">{l.toUpperCase()}</label>
                          <input
                            type="text"
                            className="w-full bg-white border border-red-200 rounded-xl px-3 py-2 text-xs font-bold focus:border-red-600 outline-none"
                            value={editingType[l]}
                            onChange={e => setEditingType({ ...editingType, [l]: e.target.value })}
                          />
                        </div>
                      ))}
                    </div>
                    <div className="flex gap-2">
                      <button onClick={handleSaveType} className="flex-1 bg-red-600 text-white py-2 rounded-xl font-black uppercase text-[10px] tracking-widest">Сохранить</button>
                      <button onClick={() => setEditingType(null)} className="px-5 py-2 bg-slate-100 text-slate-500 rounded-xl font-black uppercase text-[10px]">Отмена</button>
                    </div>
                  </div>
                ) : (
                  <div key={type.id} className="flex justify-between items-center p-3 bg-slate-50 rounded-2xl border border-slate-100">
                    <div className="min-w-0">
                      <span className="text-[10px] font-black uppercase text-slate-900">{type[lang] || type.ru || type.en || type.id}</span>
                      <span className="text-[8px] text-slate-300 ml-2">{[type.ru, type.en, type.es].filter(Boolean).join(' · ')}</span>
                    </div>
                    <div className="flex gap-1 shrink-0 ml-2">
                      <button onClick={() => setEditingType(type)} className="p-1.5 text-slate-300 hover:text-blue-500 transition-colors"><Edit2 size={13} /></button>
                      <button onClick={() => handleDeleteType(type.id)} className="p-1.5 text-slate-300 hover:text-red-600 transition-colors"><Trash2 size={13} /></button>
                    </div>
                  </div>
                )
              ))}
            </div>
          </div>
        )}
      </div>

      {editingItem && (
        <div className="fixed inset-0 z-[200] bg-slate-900/40 backdrop-blur-xl flex items-end md:items-center justify-center p-0 md:p-5 animate-in fade-in duration-200">
          <div className="bg-white w-full md:max-w-xl rounded-t-[2rem] md:rounded-[3.5rem] border border-white shadow-2xl overflow-hidden h-[90vh] md:max-h-[90vh] flex flex-col">
            <div className="p-5 border-b border-slate-50 flex justify-between items-center bg-white sticky top-0 z-10 shrink-0">
               <h3 className="font-black text-xl uppercase tracking-tighter">{editingItem.id ? 'Edit' : 'New'} Asset</h3>
               <button onClick={() => setEditingItem(null)} className="p-2 bg-slate-50 rounded-full hover:bg-red-50 hover:text-red-600"><X size={20}/></button>
            </div>
            <div className="p-5 overflow-y-auto space-y-8 flex-1 no-scrollbar">

              {/* Titles */}
              <div>
                <p className="text-[8px] font-black uppercase text-red-600 tracking-widest mb-3">Заголовки</p>
                <div className="space-y-3">
                  {(['ru', 'en', 'es'] as const).map(l => (
                    <div key={l}>
                      <label className="text-[8px] font-black uppercase text-slate-400 ml-2">{l} Заголовок</label>
                      <input type="text" className="w-full bg-slate-50 border border-slate-100 rounded-2xl px-4 py-3 text-xs font-bold focus:border-red-600 outline-none"
                        value={editingItem.title?.[l] || ''}
                        onChange={e => setEditingItem({...editingItem, title: {...editingItem.title!, [l]: e.target.value}})} />
                    </div>
                  ))}
                </div>
              </div>

              {/* Descriptions */}
              <div>
                <p className="text-[8px] font-black uppercase text-red-600 tracking-widest mb-3">Описание</p>
                <div className="space-y-3">
                  {(['ru', 'en', 'es'] as const).map(l => (
                    <div key={l}>
                      <label className="text-[8px] font-black uppercase text-slate-400 ml-2">{l} Описание</label>
                      <textarea rows={3} className="w-full bg-slate-50 border border-slate-100 rounded-2xl px-4 py-3 text-xs font-medium focus:border-red-600 outline-none resize-none"
                        value={editingItem.description?.[l] || ''}
                        onChange={e => setEditingItem({...editingItem, description: {...(editingItem.description || {en:'',ru:'',es:''}), [l]: e.target.value}})} />
                    </div>
                  ))}
                </div>
              </div>

              {/* Info */}
              <div>
                <p className="text-[8px] font-black uppercase text-red-600 tracking-widest mb-3">Основное</p>
                <div className="space-y-3">
                  <div className="flex gap-3">
                    <div className="flex-1">
                      <label className="text-[8px] font-black uppercase text-slate-400 ml-2">Тип</label>
                      <select className="w-full bg-slate-50 border border-slate-100 rounded-2xl px-4 py-3 text-xs font-bold focus:border-red-600 outline-none"
                        value={editingItem.type || ''} onChange={e => setEditingItem({...editingItem, type: e.target.value})}>
                        {db.customTypes.map(tp => <option key={tp.id} value={tp.id}>{tp[lang] || tp.ru || tp.en}</option>)}
                      </select>
                    </div>
                    <div className="flex-1">
                      <label className="text-[8px] font-black uppercase text-slate-400 ml-2">Автор</label>
                      <input type="text" className="w-full bg-slate-50 border border-slate-100 rounded-2xl px-4 py-3 text-xs font-bold focus:border-red-600 outline-none"
                        value={editingItem.author || ''} onChange={e => setEditingItem({...editingItem, author: e.target.value})} />
                    </div>
                  </div>
                  <div className="flex flex-col sm:flex-row gap-3">
                    <div className="flex-1">
                      <label className="text-[8px] font-black uppercase text-slate-400 ml-2">Дата публикации</label>
                      <input type="date" className="w-full bg-slate-50 border border-slate-100 rounded-2xl px-4 py-3 text-xs font-bold focus:border-red-600 outline-none"
                        value={editingItem.publishedDate || ''} onChange={e => setEditingItem({...editingItem, publishedDate: e.target.value})} />
                    </div>
                    <div className="flex-1">
                      <label className="text-[8px] font-black uppercase text-slate-400 ml-2">Редакционный рейтинг (0–5)</label>
                      <input type="number" min="0" max="5" step="0.1" className="w-full bg-slate-50 border border-slate-100 rounded-2xl px-4 py-3 text-xs font-bold focus:border-red-600 outline-none"
                        value={editingItem.rating ?? 0} onChange={e => setEditingItem({...editingItem, rating: parseFloat(e.target.value) || 0})} />
                    </div>
                  </div>
                </div>
              </div>

              {/* Media */}
              <div>
                <p className="text-[8px] font-black uppercase text-red-600 tracking-widest mb-3">Медиа</p>
                <div className="space-y-3">
                  <div>
                    <label className="text-[8px] font-black uppercase text-slate-400 ml-2">Обложка</label>
                    <div className="flex gap-2">
                      <input type="text" placeholder="https://..." className="flex-1 bg-slate-50 border border-slate-100 rounded-2xl px-4 py-3 text-xs font-bold focus:border-red-600 outline-none"
                        value={editingItem.coverUrl || ''} onChange={e => setEditingItem({...editingItem, coverUrl: e.target.value})} />
                      <button type="button"
                        onClick={() => coverInputRef.current?.click()}
                        disabled={uploadState?.field === 'cover' || !!stagedCoverFile}
                        title="Выбрать файл"
                        className="px-3 bg-slate-100 rounded-2xl text-slate-500 hover:bg-red-50 hover:text-red-600 transition-colors disabled:opacity-40 shrink-0">
                        <Upload size={16} />
                      </button>
                    </div>
                    {stagedCoverFile && !uploadState && (
                      <div className="mt-2 flex items-center gap-2 p-2 bg-blue-50 rounded-xl border border-blue-100">
                        <span className="text-[9px] font-bold text-blue-700 flex-1 truncate">{stagedCoverFile.name} ({formatFileSize(stagedCoverFile.size)})</span>
                        <button type="button" onClick={() => editingItem?.id && uploadCover(editingItem.id)} className="px-3 py-1 bg-blue-600 text-white text-[9px] font-black rounded-lg shrink-0">Загрузить</button>
                        <button type="button" onClick={() => { setStagedCoverFile(null); if (coverInputRef.current) coverInputRef.current.value = ''; }} className="p-1 text-blue-400 hover:text-red-500 shrink-0"><X size={12} /></button>
                      </div>
                    )}
                    {uploadState?.field === 'cover' && (
                      <div className="mt-2 bg-slate-100 rounded-full h-2 overflow-hidden">
                        <div className="bg-red-600 h-2 rounded-full transition-all duration-300" style={{ width: `${uploadState.progress}%` }} />
                      </div>
                    )}
                    <input ref={coverInputRef} type="file" accept="image/jpeg,image/png,image/webp" className="hidden"
                      onChange={e => setStagedCoverFile(e.target.files?.[0] || null)} />
                  </div>
                  <div>
                    <label className="text-[8px] font-black uppercase text-slate-400 ml-2">Видео (YouTube / Rutube / Vimeo / Twitch)</label>
                    <input type="text" placeholder="https://youtube.com/watch?v=..." className="w-full bg-slate-50 border border-slate-100 rounded-2xl px-4 py-3 text-xs font-bold focus:border-red-600 outline-none"
                      value={editingItem.videoUrl || ''} onChange={e => setEditingItem({...editingItem, videoUrl: e.target.value})} />
                  </div>
                </div>
              </div>

              {/* Content Languages */}
              <div>
                <p className="text-[8px] font-black uppercase text-red-600 tracking-widest mb-3">Языки контента</p>
                <div className="flex gap-2">
                  {(['ru', 'en', 'es'] as const).map(l => {
                    const active = (editingItem.contentLanguages || []).includes(l);
                    return (
                      <button key={l} type="button" onClick={() => handleToggleContentLang(l)}
                        className={`flex-1 py-3 rounded-xl text-[10px] font-black uppercase tracking-widest border transition-all ${active ? 'bg-slate-900 text-white border-slate-900' : 'bg-slate-50 text-slate-400 border-slate-100 hover:border-slate-300'}`}>
                        {l}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Access */}
              <div>
                <p className="text-[8px] font-black uppercase text-red-600 tracking-widest mb-3">Доступ и права</p>
                <div className="space-y-2">
                  {([
                    { key: 'isPrivate' as const,      label: 'Только по whitelist (Tier 1)' },
                    { key: 'allowDownload' as const,  label: 'Разрешить скачивание' },
                    { key: 'allowReading' as const,   label: 'Разрешить чтение онлайн' },
                  ]).map(({ key, label }) => (
                    <label key={key} className="flex items-center justify-between p-3 bg-slate-50 rounded-2xl border border-slate-100 cursor-pointer hover:border-red-100 transition-all">
                      <span className="text-xs font-bold text-slate-700">{label}</span>
                      <div className="relative">
                        <input type="checkbox" className="sr-only peer"
                          checked={!!(editingItem as any)[key]}
                          onChange={e => setEditingItem({...editingItem, [key]: e.target.checked})} />
                        <div className="w-10 h-6 bg-slate-200 rounded-full peer peer-checked:bg-red-600 transition-all after:content-[''] after:absolute after:top-[3px] after:left-[3px] after:bg-white after:rounded-full after:h-[18px] after:w-[18px] after:transition-all peer-checked:after:translate-x-4" />
                      </div>
                    </label>
                  ))}
                </div>
              </div>

              {/* File Resources */}
              <div className="border-t border-slate-100 pt-6">
                <div className="flex justify-between items-center mb-4">
                  <p className="text-[8px] font-black uppercase text-red-600 tracking-widest">Файлы</p>
                  <button onClick={handleAddFormat} className="text-[9px] font-black uppercase bg-red-50 text-red-600 px-3 py-1.5 rounded-xl border border-red-100 hover:bg-red-100 transition-colors">+ Добавить файл</button>
                </div>
                <div className="space-y-3">
                  {editingItem.formats && editingItem.formats.map((f) => (
                    <div key={f.id} className="p-3 bg-slate-50 rounded-2xl border border-slate-100">
                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <label className="text-[7px] font-black uppercase text-slate-400 ml-1">Название</label>
                          <input placeholder="PDF / EPUB / …" className="w-full bg-white border border-slate-200 rounded-lg px-2 py-1.5 text-[9px] font-bold outline-none focus:border-red-400"
                            value={f.name} onChange={e => handleUpdateFormat(f.id, 'name', e.target.value)} />
                        </div>
                        <div>
                          <label className="text-[7px] font-black uppercase text-slate-400 ml-1">Язык</label>
                          <select className="w-full bg-white border border-slate-200 rounded-lg px-2 py-1.5 text-[9px] font-bold outline-none focus:border-red-400"
                            value={f.language || 'ru'} onChange={e => handleUpdateFormat(f.id, 'language', e.target.value as any)}>
                            <option value="ru">RU</option>
                            <option value="en">EN</option>
                            <option value="es">ES</option>
                          </select>
                        </div>
                        <div className="col-span-2">
                          <label className="text-[7px] font-black uppercase text-slate-400 ml-1">URL файла</label>
                          <div className="flex gap-1">
                            <input placeholder="https://..." className="flex-1 bg-white border border-slate-200 rounded-lg px-2 py-1.5 text-[9px] font-bold outline-none focus:border-red-400"
                              value={f.url} onChange={e => handleUpdateFormat(f.id, 'url', e.target.value)} />
                            <button type="button"
                              onClick={() => { uploadingFormatId.current = f.id; fileInputRef.current?.click(); }}
                              disabled={uploadState !== null || !!stagedContentFile}
                              title="Выбрать файл"
                              className="px-2 bg-slate-100 rounded-lg text-slate-500 hover:bg-red-50 hover:text-red-600 transition-colors disabled:opacity-40 shrink-0">
                              <Upload size={12} />
                            </button>
                          </div>
                          {stagedContentFile?.formatId === f.id && !uploadState && (
                            <div className="mt-1 flex items-center gap-1.5 p-1.5 bg-blue-50 rounded-lg border border-blue-100">
                              <span className="text-[8px] font-bold text-blue-700 flex-1 truncate">{stagedContentFile.file.name} ({formatFileSize(stagedContentFile.file.size)})</span>
                              <button type="button" onClick={() => editingItem?.id && uploadContentFile(editingItem.id, f.id, f.language || 'ru')} className="px-2 py-0.5 bg-blue-600 text-white text-[8px] font-black rounded shrink-0">Загрузить</button>
                              <button type="button" onClick={() => { setStagedContentFile(null); if (fileInputRef.current) fileInputRef.current.value = ''; }} className="text-blue-400 hover:text-red-500 shrink-0"><X size={10} /></button>
                            </div>
                          )}
                          {uploadState?.field === f.id && (
                            <div className="mt-1 bg-slate-100 rounded-full h-1.5 overflow-hidden">
                              <div className="bg-red-600 h-1.5 rounded-full transition-all duration-300" style={{ width: `${uploadState.progress}%` }} />
                            </div>
                          )}
                        </div>
                        <div>
                          <label className="text-[7px] font-black uppercase text-slate-400 ml-1">Размер</label>
                          <input placeholder="2.4 MB" className="w-full bg-white border border-slate-200 rounded-lg px-2 py-1.5 text-[9px] font-bold outline-none focus:border-red-400"
                            value={f.size || ''} onChange={e => handleUpdateFormat(f.id, 'size', e.target.value)} />
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => handleDeleteFormat(f)}
                        className="mt-2 w-full py-2 bg-red-50 text-red-500 rounded-xl text-[9px] font-black uppercase tracking-widest hover:bg-red-600 hover:text-white transition-colors flex items-center justify-center gap-1.5"
                      >
                        <Trash2 size={11} /> Удалить файл с сервера
                      </button>
                    </div>
                  ))}
                  {(!editingItem.formats || editingItem.formats.length === 0) && (
                    <p className="text-center text-[9px] text-slate-300 font-bold uppercase py-3">Файлы не добавлены</p>
                  )}
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".pdf,.epub,.fb2,.djvu,.djv,.mp4,.webm,.mkv,.mp3"
                    className="hidden"
                    onChange={e => {
                      const file = e.target.files?.[0];
                      const id = uploadingFormatId.current;
                      if (file && id) setStagedContentFile({ file, formatId: id });
                    }}
                  />
                </div>
              </div>

            </div>
            <div className="p-4 bg-slate-50 border-t border-slate-100">
               <button onClick={handleSaveItem} className="w-full py-4 bg-red-600 text-white rounded-2xl font-black uppercase tracking-widest shadow-xl shadow-red-200">Save Asset</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default Admin;
