
import React, { useState, useMemo } from 'react';
import { AppState, MediaItem, Locale, MultilingualText, UserAnalytics, BotConfig, FileFormat } from '../types';
import { 
  Plus, Edit2, Trash2, Key, Users, Eye, Download, LogOut, Tags, Globe, 
  ShieldCheck, BarChart4, ChevronRight, X, UserPlus, AtSign, Unlock, Lock,
  TrendingUp, MousePointer2, Percent, Filter, Calendar, MessageSquare, Bot, Info, Copy, FileText, Link, CheckSquare, Square, BookOpen, Database, Upload, FileJson, AlertTriangle
} from 'lucide-react';
import { updateItem, deleteItem, saveDb, addUserToWhitelist, removeUserFromWhitelist, toggleGlobalAccess, updateBotConfig } from '../services/db';
import { 
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, 
  AreaChart, Area, BarChart, Bar, Legend, Cell
} from 'recharts';

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
  const [activeTab, setActiveTab] = useState<'stats' | 'items' | 'users' | 'types' | 'bot' | 'data'>('stats');
  const [editingItem, setEditingItem] = useState<Partial<MediaItem> | null>(null);
  const [newUserNickname, setNewUserNickname] = useState('');
  const [botConfig, setBotConfig] = useState<BotConfig>(db.botConfig);
  const [importJson, setImportJson] = useState('');

  // Analytics Computations
  const analytics = useMemo(() => {
    const totalViews = db.items.reduce((acc, i) => acc + i.views, 0);
    const totalDownloads = db.items.reduce((acc, i) => acc + i.downloads, 0);
    const conversionRate = totalViews > 0 ? ((totalDownloads / totalViews) * 100).toFixed(1) : 0;
    
    const topViews = [...db.items].sort((a, b) => b.views - a.views).slice(0, 5);
    const topDownloads = [...db.items].sort((a, b) => b.downloads - a.downloads).slice(0, 5);
    const topUsers = [...db.userAnalytics].sort((a, b) => (b.views + b.downloads) - (a.views + a.downloads)).slice(0, 5);

    return { totalViews, totalDownloads, conversionRate, topViews, topDownloads, topUsers };
  }, [db]);

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
        views: editingItem.views || 0,
        downloads: editingItem.downloads || 0,
        formats: editingItem.formats || [],
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
      const newFormat: FileFormat = { id: Date.now().toString(), name: 'New File', url: '', size: '0MB' };
      setEditingItem({
        ...editingItem,
        formats: [...(editingItem.formats || []), newFormat]
      });
    }
  };

  const handleUpdateFormat = (id: string, field: keyof FileFormat, value: string) => {
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

  const handleSaveBotConfig = () => {
    updateBotConfig(botConfig);
    onUpdate();
    alert('Bot Configuration Updated');
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

  const handleToggleGlobal = (e: React.ChangeEvent<HTMLInputElement>) => {
    toggleGlobalAccess(e.target.checked);
    onUpdate();
  };

  const handleExportJson = () => {
    const jsonString = JSON.stringify(db, null, 2);
    navigator.clipboard.writeText(jsonString);
    alert('Database copied to clipboard! Save it as a .json file on your computer.');
  };

  const handleImportJson = () => {
    try {
      if (!importJson.trim()) return;
      const parsed = JSON.parse(importJson);
      if (!parsed.items || !Array.isArray(parsed.items)) {
        throw new Error('Invalid Database Format');
      }
      if(confirm('WARNING: This will overwrite all current app data with the imported JSON. Continue?')) {
        saveDb(parsed);
        onUpdate();
        setImportJson('');
        alert('Database successfully imported!');
      }
    } catch (e) {
      alert('Error parsing JSON. Please ensure the format is correct.');
    }
  };

  if (!isAdmin) {
    return (
      <div className="min-h-screen flex items-center justify-center px-10 bg-slate-50">
        <div className="w-full max-w-md bg-white/80 backdrop-blur-2xl border border-slate-200 p-12 rounded-[3rem] shadow-[0_25px_60px_rgba(0,0,0,0.1)] relative">
          <div className="absolute -top-10 left-1/2 -translate-x-1/2 bg-red-600 w-20 h-20 rounded-3xl flex items-center justify-center shadow-2xl shadow-red-200">
              <ShieldCheck size={40} className="text-white" />
          </div>
          <h2 className="text-2xl font-black text-center mb-2 mt-4 tracking-tighter uppercase text-slate-900">{t.adminAccess}</h2>
          <p className="text-slate-400 text-center mb-10 text-[10px] font-black uppercase tracking-[0.2em]">Authorized Personnel Only</p>
          <form onSubmit={(e) => { e.preventDefault(); if(apiKeyInput === 'admin123') setIsAdmin(true); else alert('Invalid Access Token'); }} className="space-y-6">
            <div className="space-y-1">
                <label className="text-[9px] font-black uppercase tracking-widest text-slate-400 ml-2">{t.apiKey}</label>
                <input 
                    type="password" 
                    placeholder="••••••••" 
                    className="w-full bg-slate-50 border border-slate-200 rounded-2xl py-5 px-6 focus:ring-4 focus:ring-red-500/5 focus:border-red-600 outline-none transition-all font-mono" 
                    value={apiKeyInput} onChange={e => setApiKeyInput(e.target.value)} 
                />
            </div>
            <button className="w-full bg-red-600 py-5 rounded-[2rem] font-black text-white uppercase tracking-widest shadow-xl shadow-red-200 transition-all active:scale-95 hover:bg-red-700">
                {t.accessDashboard}
            </button>
            <button type="button" onClick={onBack} className="w-full text-slate-400 font-black text-[9px] uppercase tracking-[0.3em] hover:text-red-600 transition-colors">
                {t.back}
            </button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 pt-16 animate-in fade-in bg-slate-50 min-h-screen pb-20">
      <header className="flex items-center justify-between mb-12">
        <div>
          <h1 className="text-3xl font-black text-slate-900 tracking-tighter uppercase leading-none mb-1">Control<span className="text-red-600">Center</span></h1>
          <p className="text-[9px] font-black text-slate-400 uppercase tracking-[0.4em]">Advanced Intelligence Terminal</p>
        </div>
        <button onClick={onLogout} className="p-4 bg-white rounded-2xl text-red-600 border border-slate-200 shadow-sm active:scale-95 transition-all">
            <LogOut size={22} strokeWidth={3} />
        </button>
      </header>

      <div className="flex bg-white/50 backdrop-blur-md p-1.5 rounded-2xl mb-12 border border-slate-200/50 shadow-sm overflow-x-auto no-scrollbar">
        {(['stats', 'items', 'users', 'bot', 'types', 'data'] as const).map(tab => (
          <button key={tab} onClick={() => setActiveTab(tab)} className={`flex-1 py-3 px-4 min-w-[80px] text-[9px] font-black uppercase tracking-[0.1em] rounded-xl transition-all duration-300 ${activeTab === tab ? 'bg-red-600 text-white shadow-lg shadow-red-200' : 'text-slate-400 hover:text-slate-600'}`}>
            {t[tab] || tab}
          </button>
        ))}
      </div>

      {activeTab === 'data' && (
        <div className="space-y-8 animate-in slide-in-from-bottom-4 duration-500">
          <div className="bg-white p-8 rounded-[3rem] border border-slate-100 shadow-sm">
             <div className="flex items-center gap-4 mb-6">
                <div className="p-3 bg-red-50 text-red-600 rounded-2xl">
                    <Database size={24} />
                </div>
                <div>
                    <h3 className="text-sm font-black text-slate-900 uppercase tracking-widest">Database Management</h3>
                    <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest mt-1">Local Backup & Restore</p>
                </div>
             </div>
             
             <div className="space-y-6">
                <div className="p-6 bg-slate-50 rounded-3xl border border-slate-100">
                    <h4 className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-3 flex items-center gap-2">
                        <Download size={14} /> Export Data
                    </h4>
                    <p className="text-xs text-slate-400 mb-4 leading-relaxed">
                        Copy the entire database structure (items, users, stats) to your clipboard. 
                        Save this as a <b>.json</b> file on your computer for safekeeping.
                    </p>
                    <button onClick={handleExportJson} className="w-full py-4 bg-white border border-slate-200 rounded-2xl text-xs font-black uppercase tracking-widest text-slate-900 shadow-sm hover:border-red-600 hover:text-red-600 transition-all active:scale-95">
                        Copy JSON to Clipboard
                    </button>
                </div>

                <div className="p-6 bg-slate-50 rounded-3xl border border-slate-100">
                    <h4 className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-3 flex items-center gap-2">
                        <Upload size={14} /> Import Data
                    </h4>
                    <div className="flex items-start gap-3 mb-4 p-3 bg-amber-50 text-amber-600 rounded-2xl border border-amber-100">
                        <AlertTriangle size={16} className="shrink-0 mt-0.5" />
                        <p className="text-[10px] font-bold leading-relaxed">
                            Warning: Importing will completely overwrite existing data. Ensure your JSON format is correct.
                        </p>
                    </div>
                    <textarea 
                        className="w-full h-32 bg-white border border-slate-200 rounded-2xl p-4 text-[10px] font-mono mb-4 focus:border-red-600 outline-none"
                        placeholder='Paste your JSON content here...'
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

      {activeTab === 'bot' && (
        <div className="space-y-8 animate-in slide-in-from-bottom-4 duration-500">
          <div className="bg-white p-8 rounded-[3rem] border border-slate-100 shadow-sm">
            <h3 className="text-sm font-black mb-8 flex items-center gap-3 text-slate-900 uppercase tracking-widest underline decoration-red-600 decoration-4 underline-offset-8">
                {t.botSettings}
            </h3>

            <div className="space-y-6">
              <div className="space-y-2">
                <label className="text-[9px] font-black uppercase text-slate-400 tracking-widest ml-3">{t.botToken}</label>
                <div className="relative">
                  <Key className="absolute left-5 top-1/2 -translate-y-1/2 text-slate-300" size={16} />
                  <input 
                    type="password" 
                    placeholder="728340123:AAH_xk8..."
                    className="w-full bg-slate-50 border border-slate-100 rounded-2xl pl-12 pr-6 py-4 text-xs font-bold focus:ring-4 focus:ring-red-500/5 focus:border-red-600 outline-none transition-all" 
                    value={botConfig.token}
                    onChange={e => setBotConfig({...botConfig, token: e.target.value})}
                  />
                </div>
                <p className="text-[8px] text-slate-400 uppercase font-black ml-3 mt-1 tracking-wider italic">Obtain via @BotFather</p>
              </div>

              <div className="space-y-2">
                <label className="text-[9px] font-black uppercase text-slate-400 tracking-widest ml-3">{t.botUsername}</label>
                <div className="relative">
                  <AtSign className="absolute left-5 top-1/2 -translate-y-1/2 text-slate-300" size={16} />
                  <input 
                    type="text" 
                    className="w-full bg-slate-50 border border-slate-100 rounded-2xl pl-12 pr-6 py-4 text-xs font-bold focus:ring-4 focus:ring-red-500/5 focus:border-red-600 outline-none transition-all" 
                    value={botConfig.username}
                    onChange={e => setBotConfig({...botConfig, username: e.target.value})}
                  />
                </div>
              </div>

              <div className="space-y-4">
                <label className="text-[9px] font-black uppercase text-slate-400 tracking-widest ml-3">{t.welcomeMessage}</label>
                {(['en', 'ru', 'es'] as const).map(l => (
                  <div key={l} className="space-y-1">
                    <div className="flex items-center justify-between px-3">
                      <span className="text-[8px] font-black uppercase text-slate-300">{l}</span>
                    </div>
                    <textarea 
                      rows={2}
                      className="w-full bg-slate-50 border border-slate-100 rounded-2xl px-5 py-4 text-xs font-bold focus:ring-4 focus:ring-red-500/5 focus:border-red-600 outline-none transition-all resize-none" 
                      value={botConfig.welcomeMessage[l]}
                      onChange={e => setBotConfig({...botConfig, welcomeMessage: {...botConfig.welcomeMessage, [l]: e.target.value}})}
                    />
                  </div>
                ))}
              </div>

              <div className="space-y-2">
                <label className="text-[9px] font-black uppercase text-slate-400 tracking-widest ml-3">{t.webAppUrl}</label>
                <div className="flex gap-2">
                  <div className="relative flex-1">
                    <Globe className="absolute left-5 top-1/2 -translate-y-1/2 text-slate-300" size={16} />
                    <input 
                      type="text" 
                      className="w-full bg-slate-50 border border-slate-100 rounded-2xl pl-12 pr-6 py-4 text-xs font-bold focus:ring-4 focus:ring-red-500/5 focus:border-red-600 outline-none transition-all" 
                      value={botConfig.webAppUrl}
                      readOnly
                    />
                  </div>
                  <button 
                    onClick={() => {navigator.clipboard.writeText(botConfig.webAppUrl); alert('URL Copied');}}
                    className="p-4 bg-slate-50 border border-slate-100 rounded-2xl text-slate-400 hover:text-red-600 transition-colors"
                  >
                    <Copy size={20} />
                  </button>
                </div>
              </div>

              <div className="pt-6">
                <button 
                  onClick={handleSaveBotConfig}
                  className="w-full bg-red-600 py-6 rounded-[2.5rem] font-black uppercase tracking-[0.4em] text-white shadow-2xl shadow-red-200 active:scale-[0.98] transition-all hover:bg-red-700"
                >
                  {t.save}
                </button>
              </div>
            </div>
          </div>

          <div className="bg-white p-8 rounded-[3rem] border border-slate-100 shadow-sm">
            <div className="flex items-center gap-4 text-slate-400">
              <Info size={20} className="text-red-600" />
              <p className="text-[10px] font-bold uppercase tracking-widest leading-relaxed">
                Configure your bot on @BotFather by setting the Menu Button to point to the WebApp URL provided above.
              </p>
            </div>
          </div>
        </div>
      )}

      {activeTab === 'stats' && (
        <div className="space-y-8 animate-in slide-in-from-bottom-4 duration-500">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <div className="bg-white p-6 rounded-[2.5rem] border border-slate-100 shadow-sm relative overflow-hidden group">
              <div className="relative z-10">
                <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest mb-1">{t.totalViews}</p>
                <p className="text-4xl font-black text-slate-900 tracking-tighter">{analytics.totalViews}</p>
              </div>
              <Eye className="absolute -right-2 -bottom-2 text-slate-50 group-hover:text-red-50 transition-colors" size={80} />
            </div>
            <div className="bg-white p-6 rounded-[2.5rem] border border-slate-100 shadow-sm relative overflow-hidden group">
              <div className="relative z-10">
                <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest mb-1">{t.totalDownloads}</p>
                <p className="text-4xl font-black text-slate-900 tracking-tighter">{analytics.totalDownloads}</p>
              </div>
              <Download className="absolute -right-2 -bottom-2 text-slate-50 group-hover:text-green-50 transition-colors" size={80} />
            </div>
            <div className="bg-white p-6 rounded-[2.5rem] border border-slate-100 shadow-sm relative overflow-hidden group">
              <div className="relative z-10">
                <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest mb-1">Conversion</p>
                <p className="text-4xl font-black text-slate-900 tracking-tighter">{analytics.conversionRate}%</p>
              </div>
              <Percent className="absolute -right-2 -bottom-2 text-slate-50 group-hover:text-blue-50 transition-colors" size={80} />
            </div>
          </div>

          <div className="bg-white p-8 rounded-[3rem] border border-slate-100 shadow-sm">
            <div className="flex items-center justify-between mb-8">
              <h3 className="text-[10px] font-black uppercase tracking-widest text-slate-900">Engagement Timeline</h3>
              <div className="flex items-center gap-4">
                <div className="flex items-center gap-1.5">
                  <div className="w-2 h-2 rounded-full bg-red-600"></div>
                  <span className="text-[8px] font-black uppercase text-slate-400">Views</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <div className="w-2 h-2 rounded-full bg-green-500"></div>
                  <span className="text-[8px] font-black uppercase text-slate-400">Downloads</span>
                </div>
              </div>
            </div>
            <div className="h-64 w-full">
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
                  <Tooltip 
                    contentStyle={{ borderRadius: '16px', border: 'none', boxShadow: '0 10px 30px rgba(0,0,0,0.1)', fontSize: '10px', fontWeight: 800 }} 
                  />
                  <Area type="monotone" dataKey="views" stroke="#dc2626" strokeWidth={3} fillOpacity={1} fill="url(#colorViews)" />
                  <Area type="monotone" dataKey="downloads" stroke="#22c55e" strokeWidth={3} fillOpacity={1} fill="url(#colorDownloads)" />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
            <div className="bg-white p-8 rounded-[3rem] border border-slate-100 shadow-sm">
              <h3 className="text-[10px] font-black uppercase tracking-widest text-slate-900 mb-6 flex items-center gap-2">
                <MousePointer2 size={14} className="text-red-600" /> Hot Assets (Views)
              </h3>
              <div className="space-y-4">
                {analytics.topViews.map((item, idx) => (
                  <div key={item.id} className="flex items-center justify-between p-4 bg-slate-50 rounded-2xl border border-slate-100 hover:border-red-100 transition-all group">
                    <div className="flex items-center gap-4">
                      <span className="text-[10px] font-black text-slate-300">#{idx + 1}</span>
                      <img src={item.coverUrl} className="w-8 h-10 object-cover rounded-md" />
                      <div>
                        <p className="text-xs font-black text-slate-900 tracking-tight group-hover:text-red-600 truncate max-w-[120px]">{item.title[lang] || item.title.en}</p>
                        <p className="text-[8px] font-black text-slate-400 uppercase">{item.type}</p>
                      </div>
                    </div>
                    <div className="text-right">
                      <p className="text-sm font-black text-slate-900">{item.views}</p>
                      <p className="text-[8px] font-black text-slate-400 uppercase">Hits</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="bg-white p-8 rounded-[3rem] border border-slate-100 shadow-sm">
              <h3 className="text-[10px] font-black uppercase tracking-widest text-slate-900 mb-6 flex items-center gap-2">
                <Download size={14} className="text-green-600" /> High Utility (Downloads)
              </h3>
              <div className="space-y-4">
                {analytics.topDownloads.map((item, idx) => (
                  <div key={item.id} className="flex items-center justify-between p-4 bg-slate-50 rounded-2xl border border-slate-100 hover:border-green-100 transition-all group">
                    <div className="flex items-center gap-4">
                      <span className="text-[10px] font-black text-slate-300">#{idx + 1}</span>
                      <img src={item.coverUrl} className="w-8 h-10 object-cover rounded-md" />
                      <div>
                        <p className="text-xs font-black text-slate-900 tracking-tight group-hover:text-green-600 truncate max-w-[120px]">{item.title[lang] || item.title.en}</p>
                        <p className="text-[8px] font-black text-slate-400 uppercase">{item.type}</p>
                      </div>
                    </div>
                    <div className="text-right">
                      <p className="text-sm font-black text-slate-900">{item.downloads}</p>
                      <p className="text-[8px] font-black text-slate-400 uppercase">Files</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {activeTab === 'users' && (
        <div className="space-y-6">
          <div className="bg-white p-8 rounded-[3rem] border border-slate-100 shadow-sm mb-6">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-4">
                <div className={`p-3 rounded-2xl ${db.globalAccess ? 'bg-green-50 text-green-600' : 'bg-red-50 text-red-600'} transition-colors`}>
                  {db.globalAccess ? <Unlock size={24} strokeWidth={3} /> : <Lock size={24} strokeWidth={3} />}
                </div>
                <div>
                  <h3 className="text-sm font-black text-slate-900 uppercase tracking-widest">Public Access</h3>
                  <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest mt-0.5">
                    {db.globalAccess ? 'Open for all users' : 'Strict Whitelist Mode'}
                  </p>
                </div>
              </div>
              <label className="relative inline-flex items-center cursor-pointer">
                <input type="checkbox" className="sr-only peer" checked={db.globalAccess} onChange={handleToggleGlobal} />
                <div className="w-14 h-8 bg-slate-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[4px] after:start-[4px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-6 after:w-6 after:transition-all peer-checked:bg-red-600 shadow-inner"></div>
              </label>
            </div>
          </div>

          <div className="bg-white p-8 rounded-[3rem] border border-slate-100 shadow-sm">
            <h3 className="text-sm font-black mb-8 flex items-center gap-3 text-slate-900 uppercase tracking-widest underline decoration-red-600 decoration-4 underline-offset-8">
                {t.users}
            </h3>
            
            <div className="flex gap-3 mb-8">
              <div className="relative flex-1">
                <AtSign className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" size={16} />
                <input 
                  type="text" 
                  placeholder="Username (e.g. trader_john)" 
                  className="w-full bg-slate-50 border border-slate-100 rounded-2xl pl-10 pr-4 py-4 text-xs font-black uppercase tracking-widest focus:ring-2 focus:ring-red-600/10 focus:border-red-600 outline-none transition-all"
                  value={newUserNickname}
                  onChange={(e) => setNewUserNickname(e.target.value)}
                />
              </div>
              <button 
                onClick={handleAddUser}
                className="bg-red-600 px-6 py-4 rounded-2xl font-black text-white text-[10px] uppercase tracking-widest shadow-lg shadow-red-100 active:scale-95 transition-all"
              >
                Add
              </button>
            </div>

            <div className="space-y-2">
              <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest mb-4">Current Whitelist</p>
              {db.allowedUsers.length > 0 ? db.allowedUsers.map(user => (
                <div key={user} className="flex items-center justify-between p-4 bg-slate-50 border border-slate-100 rounded-2xl group hover:border-red-100 transition-all">
                  <div className="flex items-center gap-3">
                    <div className="p-2 bg-white rounded-lg text-red-600"><Users size={16} /></div>
                    <span className="text-sm font-black text-slate-800 tracking-tight">@{user}</span>
                  </div>
                  <button 
                    onClick={() => handleRemoveUser(user)}
                    className="p-2 text-slate-300 hover:text-red-600 hover:bg-red-50 rounded-xl transition-all"
                  >
                    <Trash2 size={18} />
                  </button>
                </div>
              )) : (
                <p className="text-xs text-slate-400 italic text-center py-10">No users in whitelist.</p>
              )}
            </div>
          </div>
        </div>
      )}

      {activeTab === 'items' && (
        <div className="space-y-6">
          <button 
            onClick={() => setEditingItem({ type: db.customTypes[0], isPrivate: false, formats: [], title: {en:'',ru:'',es:''}, description: {en:'',ru:'',es:''}, author: '', publishedDate: new Date().toISOString().split('T')[0], contentLanguages: ['en'], allowDownload: true, allowReading: true })} 
            className="w-full flex items-center justify-center gap-3 py-6 bg-red-600 rounded-[2.5rem] font-black text-white text-xs uppercase tracking-[0.3em] shadow-xl shadow-red-200 active:scale-95 transition-all"
          >
            <Plus size={20} strokeWidth={3} /> {t.addContent}
          </button>
          <div className="space-y-4">
            {db.items.map(i => (
              <div key={i.id} className="bg-white p-5 rounded-[2rem] border border-slate-100 flex items-center justify-between shadow-sm group hover:border-red-100 transition-all">
                <div className="flex items-center gap-5">
                  <div className="relative w-16 h-16 rounded-[1.2rem] overflow-hidden shadow-md">
                    <img src={i.coverUrl} className="w-full h-full object-cover" alt="" />
                  </div>
                  <div>
                    <h4 className="text-sm font-black tracking-tight text-slate-900 group-hover:text-red-600 transition-colors">{i.title[lang] || i.title.en}</h4>
                    <span className="text-[9px] font-black text-slate-400 uppercase tracking-[0.2em] mt-1 block">{i.type}</span>
                  </div>
                </div>
                <div className="flex gap-2">
                  <button onClick={() => setEditingItem(i)} className="p-3 bg-slate-50 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-xl transition-all"><Edit2 size={18} /></button>
                  <button onClick={() => { if(confirm('Delete Asset?')) { deleteItem(i.id); onUpdate(); } }} className="p-3 bg-slate-50 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-xl transition-all"><Trash2 size={18} /></button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {activeTab === 'types' && (
        <div className="space-y-8 animate-in slide-in-from-bottom-4 duration-500">
          <div className="bg-white p-8 rounded-[3rem] border border-slate-100 shadow-sm">
             <h3 className="text-sm font-black mb-8 flex items-center gap-3 text-slate-900 uppercase tracking-widest underline decoration-red-600 decoration-4 underline-offset-8">
                {t.types}
            </h3>
             <div className="grid grid-cols-2 gap-3">
                {db.customTypes.map(t => (
                  <div key={t} className="flex items-center justify-between p-4 bg-slate-50 rounded-2xl border border-slate-100">
                    <span className="text-xs font-black uppercase text-slate-900">{t}</span>
                  </div>
                ))}
             </div>
             <p className="text-[9px] text-slate-400 uppercase font-black text-center mt-6 tracking-widest">
                System Default Categories
             </p>
          </div>
        </div>
      )}

      {editingItem && (
        <div className="fixed inset-0 z-[200] bg-slate-900/40 backdrop-blur-xl flex items-center justify-center p-5">
          <div className="bg-white w-full max-w-xl rounded-[3.5rem] border border-white shadow-[0_40px_100px_rgba(0,0,0,0.25)] overflow-hidden max-h-[90vh] flex flex-col animate-in zoom-in-95 duration-300">
            <div className="p-10 border-b border-slate-50 flex justify-between items-center bg-white sticky top-0 z-10">
              <div>
                <h3 className="font-black text-2xl uppercase tracking-tighter text-slate-900">{editingItem.id ? 'Edit Asset' : 'New Asset'}</h3>
                <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest mt-1">Asset Registration Terminal</p>
              </div>
              <button onClick={() => setEditingItem(null)} className="text-slate-400 p-3 bg-slate-50 rounded-2xl hover:text-red-600 transition-colors">
                <X size={24} strokeWidth={3} />
              </button>
            </div>
            
            <div className="p-10 overflow-y-auto space-y-10 no-scrollbar">
              <div className="space-y-6">
                <h4 className="text-[10px] font-black text-red-600 uppercase tracking-[0.4em] flex items-center gap-3">
                  <span className="w-6 h-[2px] bg-red-600"></span>
                  Asset Naming
                </h4>
                <div className="grid grid-cols-1 gap-4">
                    {(['en', 'ru', 'es'] as const).map(l => (
                    <div key={l} className="space-y-1">
                        <label className="text-[8px] font-black uppercase text-slate-300 ml-3">{l}</label>
                        <input 
                            type="text" 
                            className="w-full bg-slate-50 border border-slate-100 rounded-2xl px-5 py-4 text-sm font-bold tracking-tight focus:ring-4 focus:ring-red-500/5 focus:border-red-600 outline-none transition-all" 
                            value={editingItem.title?.[l] || ''} 
                            onChange={e => setEditingItem({...editingItem, title: {...(editingItem.title as MultilingualText), [l]: e.target.value}})} 
                        />
                    </div>
                    ))}
                </div>
              </div>

              {/* Asset Permissions Section */}
              <div className="space-y-6">
                <h4 className="text-[10px] font-black text-red-600 uppercase tracking-[0.4em] flex items-center gap-3">
                  <span className="w-6 h-[2px] bg-red-600"></span>
                  Asset Permissions
                </h4>
                <div className="grid grid-cols-2 gap-4">
                  <button 
                    onClick={() => setEditingItem({ ...editingItem, allowDownload: !editingItem.allowDownload })}
                    className={`flex items-center gap-3 px-6 py-4 rounded-2xl border transition-all ${
                      editingItem.allowDownload !== false
                      ? 'bg-red-600 text-white border-red-600 shadow-lg shadow-red-200'
                      : 'bg-slate-50 text-slate-400 border-slate-100'
                    }`}
                  >
                    <Download size={16} />
                    <span className="text-[10px] font-black uppercase tracking-widest">Allow Download</span>
                  </button>
                  <button 
                    onClick={() => setEditingItem({ ...editingItem, allowReading: !editingItem.allowReading })}
                    className={`flex items-center gap-3 px-6 py-4 rounded-2xl border transition-all ${
                      editingItem.allowReading !== false
                      ? 'bg-red-600 text-white border-red-600 shadow-lg shadow-red-200'
                      : 'bg-slate-50 text-slate-400 border-slate-100'
                    }`}
                  >
                    <BookOpen size={16} />
                    <span className="text-[10px] font-black uppercase tracking-widest">Allow Read Online</span>
                  </button>
                </div>
              </div>

              <div className="space-y-6">
                <h4 className="text-[10px] font-black text-red-600 uppercase tracking-[0.4em] flex items-center gap-3">
                  <span className="w-6 h-[2px] bg-red-600"></span>
                  Content Languages
                </h4>
                <div className="flex flex-wrap gap-3">
                  {(['en', 'ru', 'es'] as Locale[]).map(l => (
                    <button 
                      key={l}
                      onClick={() => handleToggleContentLang(l)}
                      className={`flex items-center gap-3 px-6 py-4 rounded-2xl border transition-all ${
                        (editingItem.contentLanguages || []).includes(l)
                        ? 'bg-red-600 text-white border-red-600 shadow-lg shadow-red-200'
                        : 'bg-slate-50 text-slate-400 border-slate-100 hover:border-red-200'
                      }`}
                    >
                      {(editingItem.contentLanguages || []).includes(l) ? <CheckSquare size={16} /> : <Square size={16} />}
                      <span className="text-[10px] font-black uppercase tracking-widest">{l}</span>
                    </button>
                  ))}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-6">
                <div className="space-y-2">
                  <label className="text-[9px] font-black uppercase text-slate-400 tracking-widest ml-3">{t.types}</label>
                  <select 
                    className="w-full bg-slate-50 border border-slate-100 rounded-2xl px-5 py-4 text-xs font-black uppercase tracking-widest focus:ring-4 focus:ring-red-500/5 focus:border-red-600 outline-none" 
                    value={editingItem.type || ''} 
                    onChange={e => setEditingItem({...editingItem, type: e.target.value})}
                  >
                    {db.customTypes.map(tag => <option key={tag} value={tag}>{tag}</option>)}
                  </select>
                </div>
                <div className="space-y-2">
                  <label className="text-[9px] font-black uppercase text-slate-400 tracking-widest ml-3">{t.rating}</label>
                  <input 
                    type="number" step="0.1" 
                    className="w-full bg-slate-50 border border-slate-100 rounded-2xl px-5 py-4 text-sm font-black" 
                    value={editingItem.rating || ''} 
                    onChange={e => setEditingItem({...editingItem, rating: parseFloat(e.target.value)})} 
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-[9px] font-black uppercase text-slate-400 tracking-widest ml-3">{t.author}</label>
                  <input 
                    type="text" 
                    className="w-full bg-slate-50 border border-slate-100 rounded-2xl px-5 py-4 text-sm font-black" 
                    value={editingItem.author || ''} 
                    onChange={e => setEditingItem({...editingItem, author: e.target.value})} 
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-[9px] font-black uppercase text-slate-400 tracking-widest ml-3">{t.published}</label>
                  <input 
                    type="date" 
                    className="w-full bg-slate-50 border border-slate-100 rounded-2xl px-5 py-4 text-sm font-black" 
                    value={editingItem.publishedDate || ''} 
                    onChange={e => setEditingItem({...editingItem, publishedDate: e.target.value})} 
                  />
                </div>
              </div>

              <div className="space-y-4">
                <div className="space-y-2">
                    <label className="text-[9px] font-black uppercase text-slate-400 tracking-widest ml-3">Cover Image URL</label>
                    <input type="text" className="w-full bg-slate-50 border border-slate-100 rounded-2xl px-5 py-4 text-xs font-bold" value={editingItem.coverUrl || ''} onChange={e => setEditingItem({...editingItem, coverUrl: e.target.value})} />
                </div>
                <div className="space-y-2">
                    <label className="text-[9px] font-black uppercase text-slate-400 tracking-widest ml-3">{t.videoUrl}</label>
                    <input type="text" className="w-full bg-slate-50 border border-slate-100 rounded-2xl px-5 py-4 text-xs font-bold" value={editingItem.videoUrl || ''} onChange={e => setEditingItem({...editingItem, videoUrl: e.target.value})} />
                </div>
              </div>

              <div className="space-y-6">
                <h4 className="text-[10px] font-black text-red-600 uppercase tracking-[0.4em] flex items-center gap-3">
                  <span className="w-6 h-[2px] bg-red-600"></span>
                  Descriptions
                </h4>
                <div className="grid grid-cols-1 gap-4">
                    {(['en', 'ru', 'es'] as const).map(l => (
                    <div key={l} className="space-y-1">
                        <label className="text-[8px] font-black uppercase text-slate-300 ml-3">{l}</label>
                        <textarea 
                            rows={3}
                            className="w-full bg-slate-50 border border-slate-100 rounded-2xl px-5 py-4 text-sm font-medium tracking-tight focus:ring-4 focus:ring-red-500/5 focus:border-red-600 outline-none transition-all resize-none" 
                            value={editingItem.description?.[l] || ''} 
                            onChange={e => setEditingItem({...editingItem, description: {...(editingItem.description as MultilingualText), [l]: e.target.value}})} 
                        />
                    </div>
                    ))}
                </div>
              </div>

              <div className="space-y-6">
                <div className="flex items-center justify-between">
                  <h4 className="text-[10px] font-black text-red-600 uppercase tracking-[0.4em] flex items-center gap-3">
                    <span className="w-6 h-[2px] bg-red-600"></span>
                    Downloadable Assets
                  </h4>
                  <button onClick={handleAddFormat} className="p-2 bg-red-50 text-red-600 rounded-xl hover:bg-red-600 hover:text-white transition-all">
                    <Plus size={18} />
                  </button>
                </div>
                <div className="space-y-4">
                  {(editingItem.formats || []).map(format => (
                    <div key={format.id} className="p-4 bg-slate-50 border border-slate-100 rounded-2xl space-y-3 relative">
                      <button onClick={() => handleRemoveFormat(format.id)} className="absolute top-2 right-2 text-slate-300 hover:text-red-600 transition-colors">
                        <Trash2 size={14} />
                      </button>
                      <div className="grid grid-cols-2 gap-3">
                        <input 
                          type="text" placeholder="Format Name (e.g. PDF)" 
                          className="bg-white border border-slate-200 rounded-xl px-4 py-2 text-xs font-bold"
                          value={format.name} onChange={e => handleUpdateFormat(format.id, 'name', e.target.value)}
                        />
                        <input 
                          type="text" placeholder="Size (e.g. 2.4MB)" 
                          className="bg-white border border-slate-200 rounded-xl px-4 py-2 text-xs font-bold"
                          value={format.size} onChange={e => handleUpdateFormat(format.id, 'size', e.target.value)}
                        />
                      </div>
                      <input 
                        type="text" placeholder="URL (e.g. https://dropbox.com/...)" 
                        className="w-full bg-white border border-slate-200 rounded-xl px-4 py-2 text-xs font-bold"
                        value={format.url} onChange={e => handleUpdateFormat(format.id, 'url', e.target.value)}
                      />
                    </div>
                  ))}
                </div>
              </div>

              <div className="flex items-center gap-4 p-6 bg-slate-50 rounded-3xl border border-slate-100 group">
                <input 
                    type="checkbox" id="priv" 
                    className="w-6 h-6 rounded-lg text-red-600 border-slate-300 focus:ring-red-500 transition-all cursor-pointer" 
                    checked={editingItem.isPrivate} onChange={e => setEditingItem({...editingItem, isPrivate: e.target.checked})} 
                />
                <label htmlFor="priv" className="text-xs font-black uppercase tracking-[0.2em] text-slate-600 group-hover:text-red-600 transition-colors cursor-pointer">{t.private}</label>
              </div>
            </div>

            <div className="p-10 border-t border-slate-50 bg-slate-50/30 sticky bottom-0">
              <button 
                onClick={handleSaveItem} 
                className="w-full bg-red-600 py-6 rounded-[2.5rem] font-black uppercase tracking-[0.4em] text-white shadow-2xl shadow-red-200 active:scale-[0.98] transition-all hover:bg-red-700"
              >
                {t.save}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default Admin;
