
import React, { useState, useMemo, useRef, useEffect } from 'react';
import { AppState, MediaItem, Locale, ContentLang, FileFormat, CustomType, VideoLink, ArticleLink } from '../types';
import {
  Plus, Edit2, Trash2, Users, Eye, Download, LogOut, Tags,
  ShieldCheck, X, AtSign, Unlock, Lock,
  Percent, Database, Upload, Video,
  Ban, ShieldAlert, Monitor, MousePointer2, Trophy, BarChart4,
  ChevronDown, RefreshCw, GitBranch, CheckCircle2, AlertCircle,
  HardDrive, Cloud, Server, Save, RotateCcw, Settings, Newspaper, Plus as PlusIcon
} from 'lucide-react';
import { updateItem, deleteItem, saveDb, addUserToWhitelist, removeUserFromWhitelist, toggleGlobalAccess, addCustomType, deleteCustomType, updateCustomType, addToBlacklist, removeFromBlacklist, resetStats, resetTrafficStats, addAnalyticsExcludeUsername, removeAnalyticsExcludeUsername, addAnalyticsExcludeIp, removeAnalyticsExcludeIp, addAnalyticsExcludeUserId, removeAnalyticsExcludeUserId, registerBrowserExclude, removeBrowserExclude, getSkipAnalyticsToken, loadAnalytics, getServerApiKey, setServerApiKey } from '../services/db';
import {
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  AreaChart, Area
} from 'recharts';
import { pickText } from '../utils';
import CardCover from '../components/CardCover';
import { toast } from '../services/toast';

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
  const ta = t.admin;
  const [apiKeyInput, setApiKeyInput] = useState('');
  // Removed 'users' from activeTab type as it is merged into security
  const [activeTab, setActiveTab] = useState<'stats' | 'items' | 'types' | 'data' | 'security'>('stats');
  const [editingItem, setEditingItem] = useState<Partial<MediaItem> | null>(null);
  // Publication date can be a full ISO date ("2021-05-29") or just a year
  // ("2021"). The mode is derived from the stored value whenever a different
  // item is opened, then toggled manually by the admin.
  const [pubDateMode, setPubDateMode] = useState<'date' | 'year'>('date');
  useEffect(() => {
    if (!editingItem) return;
    setPubDateMode(/^\d{4}$/.test(editingItem.publishedDate || '') ? 'year' : 'date');
  }, [editingItem?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const [newUserNickname, setNewUserNickname] = useState('');
  const [newBlacklistEntry, setNewBlacklistEntry] = useState('');
  const [newTypeLabels, setNewTypeLabels] = useState({ en: '', ru: '', es: '' });
  const typedLangsRef = useRef<Set<'en' | 'ru' | 'es'>>(new Set());
  const [editingType, setEditingType] = useState<CustomType | null>(null);
  const [importJson, setImportJson] = useState('');
  const [importConfirm, setImportConfirm] = useState('');
  const [exportConfirm, setExportConfirm] = useState('');
  const [uploadState, setUploadState] = useState<{ field: string; progress: number } | null>(null);
  const [stagedCoverFile, setStagedCoverFile] = useState<File | null>(null);
  const [stagedContentFile, setStagedContentFile] = useState<{ file: File; formatId: string } | null>(null);
  const [serverApiKeyInput, setServerApiKeyInput] = useState(() => getServerApiKey());

  // Deploy control (talks to the host deploy-agent via the API mailbox endpoints)
  const [deployStatus, setDeployStatus] = useState<any>(null);
  const [deployBusy, setDeployBusy] = useState(false);
  const [itemToDelete, setItemToDelete] = useState<MediaItem | null>(null);

  const fetchDeployStatus = async () => {
    const key = getServerApiKey();
    try {
      const res = await fetch('/api/admin/deploy/status', { headers: key ? { 'x-api-key': key } : {} });
      if (res.ok) setDeployStatus(await res.json());
    } catch { /* offline */ }
  };

  const triggerDeploy = async () => {
    const key = getServerApiKey();
    setDeployBusy(true);
    try {
      const res = await fetch('/api/admin/deploy', { method: 'POST', headers: key ? { 'x-api-key': key } : {} });
      if (!res.ok) { const e = await res.json().catch(() => ({})); alert(e.error || ta.deployStartFailed); }
    } catch { alert(ta.deployAgentUnavailable); }
    finally { setDeployBusy(false); setTimeout(fetchDeployStatus, 1000); }
  };

  const setDeployMode = async (mode: 'auto' | 'manual') => {
    const key = getServerApiKey();
    try {
      await fetch('/api/admin/deploy/mode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(key ? { 'x-api-key': key } : {}) },
        body: JSON.stringify({ mode }),
      });
    } catch { /* noop */ }
    fetchDeployStatus();
  };

  // Poll deploy status while the Data tab is open
  useEffect(() => {
    if (activeTab !== 'data') return;
    fetchDeployStatus();
    const id = setInterval(fetchDeployStatus, 4000);
    return () => clearInterval(id);
  }, [activeTab]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Backups ────────────────────────────────────────────────────────────────
  const [backupInfo, setBackupInfo] = useState<any>(null);
  const [backupBusy, setBackupBusy] = useState(false);
  const [showBackupConfig, setShowBackupConfig] = useState(false);
  const [restoreTarget, setRestoreTarget] = useState<string | null>(null);
  const [restoreConfirm, setRestoreConfirm] = useState('');
  // Local working copy of the config for the editor — pre-filled from server, sent on save
  const [backupCfgDraft, setBackupCfgDraft] = useState<any>(null);

  const fetchBackupStatus = async () => {
    const key = getServerApiKey();
    try {
      const res = await fetch('/api/admin/backup/status', { headers: key ? { 'x-api-key': key } : {} });
      if (res.ok) setBackupInfo(await res.json());
    } catch { /* offline */ }
  };

  const triggerBackup = async () => {
    const key = getServerApiKey();
    setBackupBusy(true);
    try {
      const res = await fetch('/api/admin/backup/run', { method: 'POST', headers: key ? { 'x-api-key': key } : {} });
      if (!res.ok) { const e = await res.json().catch(() => ({})); alert(e.error || 'Backup failed to start'); }
    } catch { alert('Agent unavailable'); }
    finally { setBackupBusy(false); setTimeout(fetchBackupStatus, 1500); }
  };

  const triggerRestore = async (filename: string) => {
    const key = getServerApiKey();
    setBackupBusy(true);
    try {
      const res = await fetch('/api/admin/backup/restore', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(key ? { 'x-api-key': key } : {}) },
        body: JSON.stringify({ filename }),
      });
      if (!res.ok) { const e = await res.json().catch(() => ({})); alert(e.error || 'Restore failed to start'); }
    } catch { alert('Agent unavailable'); }
    finally {
      setBackupBusy(false);
      setRestoreTarget(null);
      setRestoreConfirm('');
      setTimeout(fetchBackupStatus, 1500);
    }
  };

  const saveBackupConfig = async () => {
    if (!backupCfgDraft) return;
    const key = getServerApiKey();
    setBackupBusy(true);
    try {
      const res = await fetch('/api/admin/backup/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...(key ? { 'x-api-key': key } : {}) },
        body: JSON.stringify(backupCfgDraft),
      });
      if (res.ok) {
        const data = await res.json();
        setBackupCfgDraft(data.config);
        setShowBackupConfig(false);
      } else {
        const e = await res.json().catch(() => ({}));
        alert(e.error || 'Save failed');
      }
    } catch { alert('Agent unavailable'); }
    finally { setBackupBusy(false); setTimeout(fetchBackupStatus, 800); }
  };

  // Refresh backup status alongside deploy status while Data tab is open
  useEffect(() => {
    if (activeTab !== 'data') return;
    fetchBackupStatus();
    const id = setInterval(fetchBackupStatus, 6000);
    return () => clearInterval(id);
  }, [activeTab]); // eslint-disable-line react-hooks/exhaustive-deps

  // When backup config arrives from server, seed the editor draft (only once)
  useEffect(() => {
    if (backupInfo?.config && !backupCfgDraft) setBackupCfgDraft(backupInfo.config);
  }, [backupInfo, backupCfgDraft]);

  // Pretty-print bytes for the backups list
  const formatBytes = (n: number): string => {
    if (!n) return '—';
    if (n >= 1024 * 1024 * 1024) return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
    if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
    if (n >= 1024) return (n / 1024).toFixed(0) + ' KB';
    return n + ' B';
  };
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
        alert(ta.coverUploadError + xhr.status);
      }
    };
    xhr.onerror = () => { setUploadState(null); alert(ta.networkUploadError); };
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
        alert(ta.fileUploadError + xhr.status);
      }
    };
    xhr.onerror = () => { setUploadState(null); alert(ta.networkUploadError); };
    xhr.open('POST', `/api/upload/${itemId}/file`);
    const key = getServerApiKey();
    if (key) xhr.setRequestHeader('x-api-key', key);
    xhr.send(formData);
  };

  const handleSaveItem = async () => {
    if (editingItem) {
      const hasTitle = editingItem.title && (editingItem.title.en || editingItem.title.ru || editingItem.title.es);
      if (!hasTitle) {
        toast.error(ta.titleRequired);
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

      try {
        await updateItem(itemToSave);
        toast.success(ta.saved);
        setEditingItem(null);
      } catch {
        /* error toast already shown by db layer; keep editor open */
      } finally {
        onUpdate();
      }
    }
  };

  const handleToggleContentLang = (l: ContentLang) => {
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

  const handleAddVideo = () => {
    if (!editingItem) return;
    const newVideo: VideoLink = { id: Date.now().toString(), url: '', source: 'YouTube', language: 'ru' };
    setEditingItem({ ...editingItem, videos: [...(editingItem.videos || []), newVideo] });
  };

  const handleUpdateVideo = (id: string, field: 'url' | 'source' | 'language', value: string) => {
    if (!editingItem) return;
    const updated = (editingItem.videos || []).map(v => v.id === id ? { ...v, [field]: value } : v);
    setEditingItem({ ...editingItem, videos: updated });
  };

  const handleRemoveVideo = (id: string) => {
    if (!editingItem) return;
    setEditingItem({ ...editingItem, videos: (editingItem.videos || []).filter(v => v.id !== id) });
  };

  const handleAddArticle = () => {
    if (!editingItem) return;
    const a: ArticleLink = { id: Date.now().toString(), url: '', source: 'Web', language: 'ru' };
    setEditingItem({ ...editingItem, articles: [...(editingItem.articles || []), a] });
  };

  const handleUpdateArticle = (id: string, field: keyof ArticleLink, value: string) => {
    if (!editingItem) return;
    const updated = (editingItem.articles || []).map(a => a.id === id ? { ...a, [field]: value } : a);
    setEditingItem({ ...editingItem, articles: updated });
  };

  const handleRemoveArticle = (id: string) => {
    if (!editingItem) return;
    setEditingItem({ ...editingItem, articles: (editingItem.articles || []).filter(a => a.id !== id) });
  };

  // Tags: comma-separated input → string[], trimmed, deduped, lowercase preserved
  const handleTagsChange = (raw: string) => {
    if (!editingItem) return;
    const tags = raw
      .split(',')
      .map(t => t.trim())
      .filter(Boolean);
    const unique = Array.from(new Set(tags));
    setEditingItem({ ...editingItem, tags: unique });
  };

  const handleDeleteFormat = async (f: FileFormat) => {
    if (!editingItem?.id) return;
    if (!confirm(ta.confirmDeleteFile)) return;
    const filename = f.url ? f.url.split('/').pop() : null;
    if (filename) {
      const key = getServerApiKey();
      try {
        const res = await fetch(`/api/upload/${editingItem.id}/${filename}`, {
          method: 'DELETE',
          headers: key ? { 'x-api-key': key } : {},
        });
        if (!res.ok) {
          alert(ta.fileDeleteError + res.status);
          return;
        }
      } catch {
        alert(ta.fileNetworkDeleteError);
        return;
      }
    }
    handleRemoveFormat(f.id);
  };

  const handleAddUser = async () => {
    if (newUserNickname.trim()) {
      try {
        await addUserToWhitelist(newUserNickname.toLowerCase());
        setNewUserNickname('');
        toast.success(ta.userAddedWhitelist);
      } catch { /* error toasted by db layer */ }
      finally { onUpdate(); }
    }
  };

  const handleRemoveUser = async (username: string) => {
    if (confirm(ta.confirmRemoveUser)) {
      try {
        await removeUserFromWhitelist(username);
        toast.success(ta.userRemovedWhitelist);
      } catch { /* error toasted by db layer */ }
      finally { onUpdate(); }
    }
  };

  const handleAddBlacklist = async () => {
    if (newBlacklistEntry.trim()) {
      try {
        await addToBlacklist(newBlacklistEntry);
        setNewBlacklistEntry('');
        toast.success(ta.addedBlacklist);
      } catch { /* error toasted by db layer */ }
      finally { onUpdate(); }
    }
  };

  const handleRemoveBlacklist = async (entry: string) => {
    try {
      await removeFromBlacklist(entry);
      toast.success(ta.removedBlacklist);
    } catch { /* error toasted by db layer */ }
    finally { onUpdate(); }
  };

  const handleAddType = async () => {
    const { en, ru, es } = newTypeLabels;
    if (!en.trim() && !ru.trim() && !es.trim()) return;
    const base = (en || ru || es).trim();
    const id = base.normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 20) || 'CAT_' + Date.now().toString(36).slice(-5).toUpperCase();
    try {
      await addCustomType({
        id,
        en: en.trim() || ru.trim() || es.trim(),
        ru: ru.trim() || en.trim() || es.trim(),
        es: es.trim() || en.trim() || ru.trim(),
      });
      setNewTypeLabels({ en: '', ru: '', es: '' });
      typedLangsRef.current.clear();
      toast.success(ta.sectionAdded);
    } catch { /* error toasted by db layer */ }
    finally { onUpdate(); }
  };

  const handleDeleteType = async (id: string) => {
    if (confirm(ta.confirmDeleteSection)) {
      try {
        await deleteCustomType(id);
        setEditingType(null);
        toast.success(ta.sectionDeleted);
      } catch { /* error toasted by db layer */ }
      finally { onUpdate(); }
    }
  };

  const handleSaveType = async () => {
    if (!editingType) return;
    try {
      await updateCustomType(editingType.id, { en: editingType.en, ru: editingType.ru, es: editingType.es });
      setEditingType(null);
      toast.success(ta.sectionSaved);
    } catch { /* error toasted by db layer */ }
    finally { onUpdate(); }
  };

  const handleToggleGlobal = async (e: React.ChangeEvent<HTMLInputElement>) => {
    try {
      await toggleGlobalAccess(e.target.checked);
      toast.success(e.target.checked ? ta.accessOpenAll : ta.accessWhitelistOnly);
    } catch { /* error toasted by db layer */ }
    finally { onUpdate(); }
  };

  const handleImportJson = async () => {
    if (importConfirm !== ta.rewriteWord) return;
    if (!importJson.trim()) return;
    let parsed: any;
    try {
      parsed = JSON.parse(importJson);
      if (!parsed.items || !Array.isArray(parsed.items)) throw new Error('Invalid format');
    } catch {
      toast.error(ta.invalidJson);
      return;
    }
    try {
      await saveDb(parsed);
      setImportJson('');
      setImportConfirm('');
      toast.success(ta.dbImported);
    } catch {
      /* save error already toasted; state rolled back */
    } finally {
      onUpdate();
    }
  };

  const handleExportJson = () => {
    if (exportConfirm !== ta.exportWord) return;
    const payload = {
      items: db.items,
      allowedUsers: db.allowedUsers,
      blacklist: db.blacklist,
      customTypes: db.customTypes,
      defaultLanguage: db.defaultLanguage,
      globalAccess: db.globalAccess,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `library-backup-${new Date().toISOString().split('T')[0]}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    setExportConfirm('');
  };

  const handleResetStats = async () => {
    if (confirm(ta.confirmResetStats)) {
      try {
        await resetStats();
        await loadAnalytics();
        toast.success(ta.statsReset);
      } catch {
        /* error toasted by db layer */
      } finally {
        onUpdate();
      }
    }
  };

  const handleResetTrafficStats = async () => {
    if (confirm(ta.confirmResetTraffic)) {
      try {
        await resetTrafficStats();
        await loadAnalytics();
        toast.success(ta.trafficReset);
      } catch {
        /* toasted by db layer */
      } finally {
        onUpdate();
      }
    }
  };

  // Analytics excludes — Telegram usernames + IPs that shouldn't be counted.
  // Used to keep the admin's own browsing from inflating dashboards.
  const [newExcludeUsername, setNewExcludeUsername] = useState('');
  const [newExcludeIp, setNewExcludeIp] = useState('');

  const handleAddExcludeUsername = async () => {
    const v = newExcludeUsername.trim();
    if (!v) return;
    try { await addAnalyticsExcludeUsername(v); setNewExcludeUsername(''); onUpdate(); }
    catch { /* toasted */ }
  };

  const handleRemoveExcludeUsername = async (u: string) => {
    try { await removeAnalyticsExcludeUsername(u); onUpdate(); } catch { /* toasted */ }
  };

  const handleAddExcludeIp = async () => {
    const v = newExcludeIp.trim();
    if (!v) return;
    try { await addAnalyticsExcludeIp(v); setNewExcludeIp(''); onUpdate(); }
    catch { /* toasted */ }
  };

  const handleRemoveExcludeIp = async (ip: string) => {
    try { await removeAnalyticsExcludeIp(ip); onUpdate(); } catch { /* toasted */ }
  };

  // Auto-detect: pull the current Telegram username + numeric user ID + best-
  // effort IP and add them all, AND register this browser by token. One click
  // covers every dimension — IP changes don't matter once the browser token
  // is in place.
  const handleExcludeSelf = async () => {
    const tg = (window as any).Telegram?.WebApp;
    const username = tg?.initDataUnsafe?.user?.username || '';
    const userId   = tg?.initDataUnsafe?.user?.id;
    let ip = '';
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 3000);
      const r = await fetch('https://api.ipify.org?format=json', { signal: ctrl.signal });
      clearTimeout(t);
      const j = await r.json();
      ip = j.ip || '';
    } catch { /* no internet — leave blank */ }

    const labelParts = [username && `@${username}`, ip, navigator.platform].filter(Boolean);
    const browserLabel = labelParts.join(' · ') || 'Этот браузер';

    let added = 0;
    try { if (username) { await addAnalyticsExcludeUsername(username); added++; } } catch { /* noop */ }
    try { if (userId)   { await addAnalyticsExcludeUserId(userId); added++; } } catch { /* noop */ }
    try { if (ip)       { await addAnalyticsExcludeIp(ip); added++; } } catch { /* noop */ }
    try { await registerBrowserExclude(browserLabel); added++; } catch { /* noop */ }

    if (added > 0) { toast.success(ta.excludeSelfDone); onUpdate(); }
    else alert(ta.excludeSelfNothing);
  };

  // Mark just this browser (no username/IP/ID) — useful for desktop testing
  // outside Telegram, or when admin doesn't want to expose their @handle.
  const [browserLabel, setBrowserLabel] = useState('');
  const handleRegisterBrowser = async () => {
    const label = browserLabel.trim() || navigator.platform || 'Browser';
    try {
      await registerBrowserExclude(label);
      setBrowserLabel('');
      toast.success(ta.browserRegistered);
      onUpdate();
    } catch { /* toasted */ }
  };

  const handleRemoveBrowser = async (token: string) => {
    try { await removeBrowserExclude(token); onUpdate(); } catch { /* toasted */ }
  };

  // Manual Telegram user ID input
  const [newExcludeUserId, setNewExcludeUserId] = useState('');
  const handleAddExcludeUserId = async () => {
    const v = newExcludeUserId.trim();
    if (!v) return;
    try { await addAnalyticsExcludeUserId(v); setNewExcludeUserId(''); onUpdate(); }
    catch { /* toasted */ }
  };
  const handleRemoveExcludeUserId = async (id: string) => {
    try { await removeAnalyticsExcludeUserId(id); onUpdate(); } catch { /* toasted */ }
  };

  // True iff this browser's localStorage token is in the server list.
  const thisBrowserToken = getSkipAnalyticsToken();
  const thisBrowserExcluded = !!thisBrowserToken
    && (db.analyticsExcludes?.browsers || []).some(b => b.token === thisBrowserToken);

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
          <p className="text-slate-400 text-center mb-8 text-[10px] font-black uppercase tracking-[0.2em]">{ta.authorizedOnly}</p>
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
      className="p-4 md:p-6 animate-in fade-in min-h-screen pb-24 max-w-7xl mx-auto overflow-x-hidden"
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
                      type="text" placeholder={ta.telegramUsername} className="flex-1 bg-slate-50 border border-slate-100 rounded-2xl px-4 py-3 text-xs font-black uppercase focus:border-red-600 outline-none"
                      value={newUserNickname} onChange={e => setNewUserNickname(e.target.value)}
                    />
                    <button onClick={handleAddUser} className="bg-red-600 text-white px-6 rounded-2xl font-black uppercase text-[10px] tracking-widest hover:bg-red-700 transition-colors">{ta.add}</button>
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
                        <p className="text-[10px] uppercase font-black text-slate-400 col-span-2 text-center py-4">{ta.whitelistEmpty}</p>
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
                          <p className="col-span-2 text-center text-[10px] text-slate-400 font-bold uppercase py-6">{ta.blacklistEmpty}</p>
                      )}
                  </div>
            </div>

            {/* 4. Access Logs */}
            <div className="bg-white p-5 md:p-8 rounded-[2rem] border border-slate-100 shadow-sm overflow-hidden">
                <h3 className="text-[10px] font-black uppercase tracking-widest text-slate-900 mb-6 flex items-center gap-2">
                      <Monitor size={14} className="text-blue-600" /> {t.accessLogs}
                </h3>
                <div className="overflow-x-auto overflow-y-auto max-h-[420px]">
                    <table className="w-full text-left border-collapse min-w-[500px]">
                        <thead className="sticky top-0 z-10 bg-white">
                            <tr className="border-b border-slate-100">
                                <th className="p-3 text-[9px] font-black uppercase text-slate-400 tracking-widest bg-white">{ta.time}</th>
                                <th className="p-3 text-[9px] font-black uppercase text-slate-400 tracking-widest bg-white">{ta.user}</th>
                                <th className="p-3 text-[9px] font-black uppercase text-slate-400 tracking-widest bg-white">{t.ipAddress}</th>
                                <th className="p-3 text-[9px] font-black uppercase text-slate-400 tracking-widest text-right bg-white">{t.device}</th>
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
                                <tr><td colSpan={4} className="p-8 text-center text-slate-400">{ta.noLogs}</td></tr>
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
                                   <CardCover item={item} lang={lang} />
                                </div>
                                <div className="min-w-0">
                                    <p className="text-xs font-black text-slate-900 tracking-tight group-hover:text-red-600 truncate">{pickText(item.title, lang)}</p>
                                    <p className="text-[8px] font-black text-slate-400 uppercase">{item.type}</p>
                                </div>
                            </div>
                            <div className="text-right shrink-0">
                                <p className="text-sm font-black text-slate-900">{item.views}</p>
                                <p className="text-[8px] font-black text-slate-400 uppercase">{ta.hits}</p>
                            </div>
                        </div>
                        ))}
                         {analytics.topViews.length === 0 && <p className="text-center text-xs text-slate-300 font-bold uppercase py-4">{ta.noData}</p>}
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
                                   <CardCover item={item} lang={lang} />
                                </div>
                                <div className="min-w-0">
                                    <p className="text-xs font-black text-slate-900 tracking-tight group-hover:text-green-600 truncate">{pickText(item.title, lang)}</p>
                                    <p className="text-[8px] font-black text-slate-400 uppercase">{item.type}</p>
                                </div>
                            </div>
                            <div className="text-right shrink-0">
                                <p className="text-sm font-black text-slate-900">{item.downloads}</p>
                                <p className="text-[8px] font-black text-slate-400 uppercase">{ta.files}</p>
                            </div>
                        </div>
                        ))}
                        {analytics.topDownloads.length === 0 && <p className="text-center text-xs text-slate-300 font-bold uppercase py-4">{ta.noData}</p>}
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
                                <th className="p-3 text-[8px] font-black uppercase text-slate-400 tracking-widest">{ta.rank}</th>
                                <th className="p-3 text-[8px] font-black uppercase text-slate-400 tracking-widest">{ta.user}</th>
                                <th className="p-3 text-[8px] font-black uppercase text-slate-400 tracking-widest">{ta.interests}</th>
                                <th className="p-3 text-[8px] font-black uppercase text-slate-400 tracking-widest text-right">{ta.activity}</th>
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
                                <tr><td colSpan={4} className="p-8 text-center text-xs text-slate-400 font-bold uppercase tracking-widest">{ta.noUserData}</td></tr>
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
          <div className="space-y-6 md:space-y-8 animate-in slide-in-from-bottom-4 duration-500 min-w-0 overflow-x-hidden">

            {/* Deploy control */}
            <div className="bg-white p-5 md:p-8 rounded-[2rem] border border-slate-100 shadow-sm">
              <div className="flex items-center gap-4 mb-6">
                <div className="p-3 bg-red-50 text-red-600 rounded-2xl"><GitBranch size={24} /></div>
                <div>
                  <h3 className="text-sm font-black text-slate-900 uppercase tracking-widest">{ta.deployTitle}</h3>
                  <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest mt-1">{ta.deploySubtitle}</p>
                </div>
              </div>

              {(() => {
                const ds = deployStatus;
                const offline = !ds || ds.agent === 'offline';
                const deploying = !!ds?.deploying;
                const mode = ds?.mode === 'auto' ? 'auto' : 'manual';
                return (
                  <div className="space-y-5">
                    {/* Status line */}
                    <div className="p-5 bg-slate-50 rounded-3xl border border-slate-100 space-y-3">
                      {offline ? (
                        <p className="text-[10px] font-bold text-slate-400 flex items-center gap-2">
                          <AlertCircle size={14} className="text-amber-500" /> {ta.agentOffline}
                        </p>
                      ) : (
                        <>
                          <div className="flex items-center justify-between">
                            <span className="text-[9px] font-black uppercase tracking-widest text-slate-400">{ta.statusLabel}</span>
                            {deploying ? (
                              <span className="text-[10px] font-black text-blue-600 flex items-center gap-1.5"><RefreshCw size={12} className="animate-spin" /> {ta.deployingStatus}</span>
                            ) : ds?.behind ? (
                              <span className="text-[10px] font-black text-amber-600 flex items-center gap-1.5"><AlertCircle size={12} /> {ta.hasUpdates}</span>
                            ) : (
                              <span className="text-[10px] font-black text-green-600 flex items-center gap-1.5"><CheckCircle2 size={12} /> {ta.upToDate}</span>
                            )}
                          </div>
                          <div className="flex items-center justify-between text-[10px] font-bold text-slate-500">
                            <span>{ta.serverVersion}</span>
                            <span className="font-mono">{ds?.localCommit || '—'}{ds?.behind ? ` → ${ds?.remoteCommit}` : ''}</span>
                          </div>
                          {ds?.lastFinishedAt && (
                            <div className="flex items-center justify-between text-[10px] font-bold text-slate-500">
                              <span>{ta.lastDeploy}</span>
                              <span className="flex items-center gap-1.5">
                                {ds.lastSuccess === false
                                  ? <span className="text-red-600 flex items-center gap-1"><AlertCircle size={11} /> {ta.deployErr}</span>
                                  : <span className="text-green-600 flex items-center gap-1"><CheckCircle2 size={11} /> {ta.deployOk}</span>}
                                <span className="text-slate-400">{new Date(ds.lastFinishedAt).toLocaleString()}</span>
                              </span>
                            </div>
                          )}
                          {ds?.lastSuccess === false && ds?.lastLogTail && (
                            <pre className="mt-1 max-h-28 overflow-auto bg-slate-900 text-red-300 text-[9px] leading-snug rounded-xl p-3 whitespace-pre-wrap break-words">{ds.lastLogTail}</pre>
                          )}
                        </>
                      )}
                    </div>

                    {/* Manual deploy button */}
                    <button
                      onClick={triggerDeploy}
                      disabled={offline || deploying || deployBusy}
                      className="w-full py-4 bg-red-600 text-white rounded-2xl text-xs font-black uppercase tracking-widest shadow-md active:scale-95 transition-all hover:bg-red-700 disabled:opacity-40 flex items-center justify-center gap-2"
                    >
                      <RefreshCw size={16} className={deploying ? 'animate-spin' : ''} />
                      {deploying ? ta.deployButtonBusy : ta.deployButton}
                    </button>

                    {/* Auto / manual toggle */}
                    <div className="flex items-center justify-between p-4 bg-slate-50 rounded-3xl border border-slate-100">
                      <div>
                        <p className="text-[11px] font-black text-slate-900 uppercase tracking-widest">{ta.autoDeploy}</p>
                        <p className="text-[9px] font-bold text-slate-400 mt-0.5">{mode === 'auto' ? ta.autoOn : ta.autoOff}</p>
                      </div>
                      <label className="relative inline-flex items-center cursor-pointer shrink-0">
                        <input type="checkbox" className="sr-only peer" disabled={offline} checked={mode === 'auto'} onChange={e => setDeployMode(e.target.checked ? 'auto' : 'manual')} />
                        <div className="w-12 h-7 bg-slate-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-5 after:content-[''] after:absolute after:top-0.5 after:left-0.5 after:bg-white after:rounded-full after:h-6 after:w-6 after:transition-all peer-checked:bg-red-600 peer-disabled:opacity-40" />
                      </label>
                    </div>
                  </div>
                );
              })()}
            </div>

            {/* ── Database backups ────────────────────────────────────────── */}
            <div className="bg-white p-5 md:p-8 rounded-[2rem] border border-slate-100 shadow-sm">
              <div className="flex items-center gap-4 mb-6">
                <div className="p-3 bg-red-50 text-red-600 rounded-2xl"><HardDrive size={24} /></div>
                <div className="flex-1">
                  <h3 className="text-sm font-black text-slate-900 uppercase tracking-widest">{ta.backupTitle}</h3>
                  <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest mt-1">{ta.backupSubtitle}</p>
                </div>
                <button
                  onClick={() => setShowBackupConfig(true)}
                  className="p-2.5 bg-slate-100 text-slate-500 hover:bg-red-50 hover:text-red-600 rounded-xl transition-colors"
                  title={ta.backupConfigure}
                >
                  <Settings size={16} />
                </button>
              </div>

              {(() => {
                const bi = backupInfo;
                const offline = !bi || bi.agent === 'offline';
                const st = bi?.status;
                const cfg = bi?.config || backupCfgDraft;
                const last = st?.lastRun;
                const targetSummary = cfg?.targets ? Object.entries(cfg.targets)
                  .filter(([, v]: any) => v?.enabled).map(([k]) => k) : [];
                return (
                  <div className="space-y-5">
                    {/* Status row */}
                    <div className="p-5 bg-slate-50 rounded-3xl border border-slate-100 space-y-3">
                      {offline ? (
                        <p className="text-[10px] font-bold text-slate-400 flex items-center gap-2">
                          <AlertCircle size={14} className="text-amber-500" /> {ta.backupAgentOffline}
                        </p>
                      ) : (
                        <>
                          <div className="flex items-center justify-between">
                            <span className="text-[9px] font-black uppercase tracking-widest text-slate-400">{ta.backupActiveTargets}</span>
                            <span className="text-[10px] font-black text-slate-600">
                              {targetSummary.length > 0 ? targetSummary.join(' · ') : ta.backupNoTargets}
                            </span>
                          </div>
                          <div className="flex items-center justify-between">
                            <span className="text-[9px] font-black uppercase tracking-widest text-slate-400">{ta.backupSchedule}</span>
                            <span className="text-[10px] font-black text-slate-600">
                              {cfg?.schedule?.enabled
                                ? `${ta.backupEvery} ${cfg.schedule.intervalHours}${ta.backupHours}`
                                : ta.backupScheduleOff}
                            </span>
                          </div>
                          {last && (
                            <div className="flex items-center justify-between">
                              <span className="text-[9px] font-black uppercase tracking-widest text-slate-400">{ta.backupLastRun}</span>
                              <span className="flex items-center gap-1.5 text-[10px] font-bold">
                                {last.success
                                  ? <span className="text-green-600 flex items-center gap-1"><CheckCircle2 size={11} /> {ta.deployOk}</span>
                                  : <span className="text-red-600 flex items-center gap-1"><AlertCircle size={11} /> {ta.deployErr}</span>
                                }
                                <span className="text-slate-400">{new Date(last.finishedAt || last.startedAt).toLocaleString()}</span>
                              </span>
                            </div>
                          )}
                          {last?.error && (
                            <p className="text-[10px] font-mono text-red-500 bg-red-50 p-2 rounded-lg break-words">{last.error}</p>
                          )}
                          {st?.lastRestore && (
                            <div className="flex items-center justify-between border-t border-slate-200 pt-2">
                              <span className="text-[9px] font-black uppercase tracking-widest text-slate-400">{ta.backupLastRestore}</span>
                              <span className="text-[10px] font-bold">
                                {st.lastRestore.success === false
                                  ? <span className="text-red-600">{ta.deployErr}</span>
                                  : st.lastRestore.success
                                  ? <span className="text-green-600">{ta.deployOk}</span>
                                  : <span className="text-blue-600">…</span>
                                }
                                <span className="text-slate-400 ml-2">{st.lastRestore.filename}</span>
                              </span>
                            </div>
                          )}
                        </>
                      )}
                    </div>

                    {/* Run-now button */}
                    <button
                      onClick={triggerBackup}
                      disabled={offline || backupBusy}
                      className="w-full py-4 bg-red-600 text-white rounded-2xl text-xs font-black uppercase tracking-widest shadow-md active:scale-95 transition-all hover:bg-red-700 disabled:opacity-40 flex items-center justify-center gap-2"
                    >
                      <Save size={16} /> {ta.backupRunNow}
                    </button>

                    {/* Backups list */}
                    {!offline && (
                      <div>
                        <p className="text-[8px] font-black uppercase text-red-600 tracking-widest mb-3">{ta.backupAvailable}</p>
                        <div className="space-y-2 max-h-64 overflow-y-auto">
                          {(st?.backups || []).length === 0 && (
                            <p className="text-center text-[10px] text-slate-300 font-bold uppercase tracking-widest py-4">{ta.backupNoBackups}</p>
                          )}
                          {(st?.backups || []).map((b: any) => (
                            <div key={b.filename} className="flex items-center justify-between p-3 bg-slate-50 rounded-2xl border border-slate-100">
                              <div className="min-w-0 flex-1">
                                <p className="text-[10px] font-mono font-bold text-slate-700 truncate">{b.filename}</p>
                                <p className="text-[9px] text-slate-400">{new Date(b.createdAt).toLocaleString()} · {formatBytes(b.sizeBytes)}</p>
                              </div>
                              <button
                                onClick={() => { setRestoreTarget(b.filename); setRestoreConfirm(''); }}
                                disabled={backupBusy}
                                className="ml-3 px-3 py-2 bg-white border border-slate-200 text-slate-500 hover:bg-amber-50 hover:text-amber-600 hover:border-amber-200 text-[9px] font-black uppercase tracking-widest rounded-xl transition-colors flex items-center gap-1.5 shrink-0 disabled:opacity-40"
                              >
                                <RotateCcw size={11} /> {ta.backupRestore}
                              </button>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })()}
            </div>

            <div className="bg-white p-5 md:p-8 rounded-[2rem] border border-slate-100 shadow-sm">
              <div className="flex items-center gap-4 mb-6">
                  <div className="p-3 bg-red-50 text-red-600 rounded-2xl">
                      <Database size={24} />
                  </div>
                  <div>
                      <h3 className="text-sm font-black text-slate-900 uppercase tracking-widest">{ta.database}</h3>
                      <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest mt-1">{ta.backupRestore}</p>
                  </div>
              </div>
              <div className="space-y-6">
                  <div className="p-5 md:p-6 bg-slate-50 rounded-3xl border border-slate-100">
                      <h4 className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-1 flex items-center gap-2">
                          <Upload size={14} /> Server API Key
                      </h4>
                      <p className="text-[9px] text-slate-400 font-bold mb-3">{ta.apiKeyDesc}</p>
                      <div className="flex gap-2">
                        <input
                          type="password"
                          className="flex-1 min-w-0 bg-white border border-slate-200 rounded-2xl px-4 py-3 text-xs font-mono focus:border-red-600 outline-none"
                          placeholder={ta.apiKeyPlaceholder}
                          value={serverApiKeyInput}
                          onChange={e => setServerApiKeyInput(e.target.value)}
                        />
                        <button
                          onClick={() => { setServerApiKey(serverApiKeyInput); alert(ta.apiKeySaved); }}
                          className="px-5 bg-slate-900 text-white rounded-2xl text-[10px] font-black uppercase tracking-widest shrink-0"
                        >
                          {ta.save}
                        </button>
                      </div>
                  </div>
                  {/* Analytics excludes — don't count specific identifiers */}
                  <div className="p-5 md:p-6 bg-slate-50 rounded-3xl border border-slate-200 overflow-hidden">
                      <h4 className="text-[10px] font-black text-slate-700 uppercase tracking-widest mb-1 flex items-center gap-2">
                          <Ban size={14} /> {ta.excludesTitle}
                      </h4>
                      <p className="text-[9px] text-slate-400 font-bold mb-3">{ta.excludesDesc}</p>

                      {/* "This browser is excluded" indicator */}
                      <div className={`mb-4 px-3 py-2 rounded-xl text-[10px] font-bold flex items-center justify-between gap-2 ${thisBrowserExcluded ? 'bg-green-50 text-green-700 border border-green-100' : 'bg-amber-50 text-amber-700 border border-amber-100'}`}>
                          <span className="flex items-center gap-1.5">
                              {thisBrowserExcluded
                                  ? <><CheckCircle2 size={12} /> {ta.browserExcluded}</>
                                  : <><AlertCircle size={12} /> {ta.browserNotExcluded}</>}
                          </span>
                          {thisBrowserExcluded && thisBrowserToken && (
                              <span className="font-mono text-[9px] opacity-60">{thisBrowserToken.slice(0, 8)}…</span>
                          )}
                      </div>

                      <button
                        onClick={handleExcludeSelf}
                        className="w-full mb-4 py-3 bg-slate-900 text-white rounded-2xl text-[10px] font-black uppercase tracking-widest hover:bg-slate-800 active:scale-95 transition-all flex items-center justify-center gap-2"
                      >
                        <ShieldCheck size={13} /> {ta.excludeSelfBtn}
                      </button>

                      {/* Usernames */}
                      <label className="text-[8px] font-black uppercase text-slate-500 tracking-widest ml-1">{ta.excludeUsernames}</label>
                      <div className="flex gap-2 mt-1 mb-2">
                          <input
                              className="flex-1 min-w-0 bg-white border border-slate-200 rounded-2xl px-4 py-3 text-xs font-bold focus:border-slate-500 outline-none"
                              placeholder="@username"
                              value={newExcludeUsername}
                              onChange={e => setNewExcludeUsername(e.target.value)}
                              onKeyDown={e => { if (e.key === 'Enter') handleAddExcludeUsername(); }}
                          />
                          <button onClick={handleAddExcludeUsername} className="px-5 bg-slate-900 text-white rounded-2xl text-[10px] font-black uppercase tracking-widest shrink-0">{ta.add}</button>
                      </div>
                      <div className="flex flex-wrap gap-1.5 mb-4 min-h-[1.5rem]">
                          {(db.analyticsExcludes?.usernames || []).length === 0 && (
                              <span className="text-[9px] text-slate-300 font-bold uppercase tracking-widest">{ta.excludesEmpty}</span>
                          )}
                          {(db.analyticsExcludes?.usernames || []).map(u => (
                              <span key={u} className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-white border border-slate-200 rounded-lg text-[10px] font-bold text-slate-700">
                                  @{u}
                                  <button onClick={() => handleRemoveExcludeUsername(u)} className="text-slate-300 hover:text-red-500 transition-colors"><X size={10} /></button>
                              </span>
                          ))}
                      </div>

                      {/* IPs */}
                      <label className="text-[8px] font-black uppercase text-slate-500 tracking-widest ml-1">{ta.excludeIps}</label>
                      <div className="flex gap-2 mt-1 mb-2">
                          <input
                              className="flex-1 min-w-0 bg-white border border-slate-200 rounded-2xl px-4 py-3 text-xs font-bold focus:border-slate-500 outline-none"
                              placeholder="1.2.3.4"
                              value={newExcludeIp}
                              onChange={e => setNewExcludeIp(e.target.value)}
                              onKeyDown={e => { if (e.key === 'Enter') handleAddExcludeIp(); }}
                          />
                          <button onClick={handleAddExcludeIp} className="px-5 bg-slate-900 text-white rounded-2xl text-[10px] font-black uppercase tracking-widest shrink-0">{ta.add}</button>
                      </div>
                      <div className="flex flex-wrap gap-1.5 mb-4 min-h-[1.5rem]">
                          {(db.analyticsExcludes?.ips || []).length === 0 && (
                              <span className="text-[9px] text-slate-300 font-bold uppercase tracking-widest">{ta.excludesEmpty}</span>
                          )}
                          {(db.analyticsExcludes?.ips || []).map(ip => (
                              <span key={ip} className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-white border border-slate-200 rounded-lg text-[10px] font-bold text-slate-700 font-mono">
                                  {ip}
                                  <button onClick={() => handleRemoveExcludeIp(ip)} className="text-slate-300 hover:text-red-500 transition-colors"><X size={10} /></button>
                              </span>
                          ))}
                      </div>

                      {/* Telegram numeric user IDs — stable across username changes */}
                      <label className="text-[8px] font-black uppercase text-slate-500 tracking-widest ml-1">{ta.excludeUserIds}</label>
                      <div className="flex gap-2 mt-1 mb-2">
                          <input
                              className="flex-1 min-w-0 bg-white border border-slate-200 rounded-2xl px-4 py-3 text-xs font-bold focus:border-slate-500 outline-none"
                              placeholder="123456789"
                              inputMode="numeric"
                              value={newExcludeUserId}
                              onChange={e => setNewExcludeUserId(e.target.value)}
                              onKeyDown={e => { if (e.key === 'Enter') handleAddExcludeUserId(); }}
                          />
                          <button onClick={handleAddExcludeUserId} className="px-5 bg-slate-900 text-white rounded-2xl text-[10px] font-black uppercase tracking-widest shrink-0">{ta.add}</button>
                      </div>
                      <div className="flex flex-wrap gap-1.5 mb-4 min-h-[1.5rem]">
                          {(db.analyticsExcludes?.userIds || []).length === 0 && (
                              <span className="text-[9px] text-slate-300 font-bold uppercase tracking-widest">{ta.excludesEmpty}</span>
                          )}
                          {(db.analyticsExcludes?.userIds || []).map(uid => (
                              <span key={uid} className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-white border border-slate-200 rounded-lg text-[10px] font-bold text-slate-700 font-mono">
                                  {uid}
                                  <button onClick={() => handleRemoveExcludeUserId(uid)} className="text-slate-300 hover:text-red-500 transition-colors"><X size={10} /></button>
                              </span>
                          ))}
                      </div>

                      {/* Registered browsers (per-device localStorage tokens) */}
                      <label className="text-[8px] font-black uppercase text-slate-500 tracking-widest ml-1">{ta.excludeBrowsers}</label>
                      <p className="text-[9px] text-slate-400 mt-1 mb-2 leading-relaxed">{ta.browsersHelp}</p>
                      <div className="flex gap-2 mb-2">
                          <input
                              className="flex-1 min-w-0 bg-white border border-slate-200 rounded-2xl px-4 py-3 text-xs font-bold focus:border-slate-500 outline-none"
                              placeholder={ta.browserLabelPh}
                              value={browserLabel}
                              onChange={e => setBrowserLabel(e.target.value)}
                              onKeyDown={e => { if (e.key === 'Enter') handleRegisterBrowser(); }}
                          />
                          <button onClick={handleRegisterBrowser} title={ta.registerThisBrowser} className="px-4 bg-slate-900 text-white rounded-2xl text-[10px] font-black uppercase tracking-widest shrink-0 flex items-center justify-center"><Plus size={14} strokeWidth={3} /></button>
                      </div>
                      <div className="space-y-1.5 min-h-[1.5rem]">
                          {(db.analyticsExcludes?.browsers || []).length === 0 && (
                              <span className="text-[9px] text-slate-300 font-bold uppercase tracking-widest">{ta.excludesEmpty}</span>
                          )}
                          {(db.analyticsExcludes?.browsers || []).map(b => {
                              const isMe = b.token === thisBrowserToken;
                              return (
                                  <div key={b.token} className={`flex items-center gap-2 px-3 py-2 rounded-xl text-[10px] font-bold border ${isMe ? 'bg-green-50 border-green-100 text-green-700' : 'bg-white border-slate-200 text-slate-700'}`}>
                                      <span className="font-mono text-slate-400 shrink-0">{b.token.slice(0, 8)}…</span>
                                      <span className="flex-1 min-w-0 truncate">{b.label}</span>
                                      <span className="text-[9px] text-slate-300 shrink-0">{new Date(b.addedAt).toLocaleDateString()}</span>
                                      {isMe && <span className="text-[9px] font-black uppercase text-green-600 shrink-0">{ta.youHere}</span>}
                                      <button onClick={() => handleRemoveBrowser(b.token)} className="text-slate-300 hover:text-red-500 transition-colors shrink-0"><X size={11} /></button>
                                  </div>
                              );
                          })}
                      </div>
                  </div>

                  {/* Reset content stats */}
                  <div className="p-5 md:p-6 bg-red-50 rounded-3xl border border-red-100">
                      <h4 className="text-[10px] font-black text-red-500 uppercase tracking-widest mb-3 flex items-center gap-2">
                          <BarChart4 size={14} /> {ta.resetStatsTitle}
                      </h4>
                      <p className="text-[9px] text-slate-400 font-bold mb-4">{ta.resetStatsDesc}</p>
                      <button onClick={handleResetStats} className="w-full py-4 bg-red-600 text-white rounded-2xl text-xs font-black uppercase tracking-widest shadow-md active:scale-95 transition-all hover:bg-red-700">
                          {ta.resetStatsButton}
                      </button>
                  </div>

                  {/* Reset traffic stats */}
                  <div className="p-5 md:p-6 bg-red-50 rounded-3xl border border-red-100">
                      <h4 className="text-[10px] font-black text-red-500 uppercase tracking-widest mb-3 flex items-center gap-2">
                          <Monitor size={14} /> {ta.resetTrafficTitle}
                      </h4>
                      <p className="text-[9px] text-slate-400 font-bold mb-4">{ta.resetTrafficDesc}</p>
                      <button onClick={handleResetTrafficStats} className="w-full py-4 bg-red-600 text-white rounded-2xl text-xs font-black uppercase tracking-widest shadow-md active:scale-95 transition-all hover:bg-red-700">
                          {ta.resetTrafficButton}
                      </button>
                  </div>

                  {/* Export */}
                  <div className="p-5 md:p-6 bg-amber-50 rounded-3xl border border-amber-200">
                      <h4 className="text-[10px] font-black text-amber-700 uppercase tracking-widest mb-1 flex items-center gap-2">
                          <Database size={14} /> {ta.exportTitle}
                      </h4>
                      <p className="text-[9px] text-amber-600 font-bold mb-4">
                          {ta.exportDesc}
                      </p>
                      <label className="text-[8px] font-black uppercase text-amber-700 tracking-widest ml-1">
                          {ta.exportConfirmLabel}
                      </label>
                      <div className="flex gap-2 mt-1">
                          <input
                              className="flex-1 min-w-0 bg-white border border-amber-200 rounded-2xl px-4 py-3 text-xs font-bold focus:border-amber-500 outline-none"
                              placeholder={ta.exportWord}
                              value={exportConfirm}
                              onChange={e => setExportConfirm(e.target.value)}
                          />
                          <button
                              onClick={handleExportJson}
                              disabled={exportConfirm !== ta.exportWord}
                              className="px-5 bg-amber-600 text-white rounded-2xl text-[10px] font-black uppercase tracking-widest disabled:opacity-40 transition-all active:scale-95"
                          >
                              {ta.exportButton}
                          </button>
                      </div>
                  </div>

                  {/* Import */}
                  <div className="p-5 md:p-6 bg-red-50 rounded-3xl border border-red-200">
                      <h4 className="text-[10px] font-black text-red-700 uppercase tracking-widest mb-1 flex items-center gap-2">
                          <Upload size={14} /> {ta.importTitle}
                      </h4>
                      <p className="text-[9px] text-red-600 font-bold mb-4">
                          {ta.importDesc}
                      </p>
                      <textarea
                          className="w-full h-28 bg-white border border-red-200 rounded-2xl p-4 text-[10px] font-mono mb-3 focus:border-red-600 outline-none"
                          placeholder={ta.importPlaceholder}
                          value={importJson}
                          onChange={e => setImportJson(e.target.value)}
                      />
                      <label className="text-[8px] font-black uppercase text-red-700 tracking-widest ml-1">
                          {ta.importConfirmLabel}
                      </label>
                      <div className="flex gap-2 mt-1">
                          <input
                              className="flex-1 min-w-0 bg-white border border-red-200 rounded-2xl px-4 py-3 text-xs font-bold focus:border-red-600 outline-none"
                              placeholder={ta.rewriteWord}
                              value={importConfirm}
                              onChange={e => setImportConfirm(e.target.value)}
                          />
                          <button
                              onClick={handleImportJson}
                              disabled={importConfirm !== ta.rewriteWord || !importJson.trim()}
                              className="px-5 bg-red-700 text-white rounded-2xl text-[10px] font-black uppercase tracking-widest disabled:opacity-40 transition-all active:scale-95"
                          >
                              {ta.importButton}
                          </button>
                      </div>
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
                           <div className="w-12 h-12 rounded-xl overflow-hidden bg-slate-50 shrink-0 group">
                              <CardCover item={i} lang={lang} />
                           </div>
                           <div className="min-w-0">
                              <h4 className="text-xs font-black text-slate-900 truncate">{pickText(i.title, lang)}</h4>
                              <span className="text-[8px] font-black text-slate-400 uppercase tracking-widest">{i.type}</span>
                           </div>
                        </div>
                        <div className="flex gap-2">
                           <button onClick={() => setEditingItem(i)} className="p-2 bg-slate-50 rounded-xl hover:bg-red-50 hover:text-red-600"><Edit2 size={16}/></button>
                           <button onClick={() => setItemToDelete(i)} className="p-2 bg-slate-50 rounded-xl hover:bg-red-50 hover:text-red-600" aria-label={ta.deleteItem}><Trash2 size={16}/></button>
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
                    <p className="text-[8px] font-black uppercase text-red-600 tracking-widest">{ta.editSection}</p>
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
                      <button onClick={handleSaveType} className="flex-1 bg-red-600 text-white py-2 rounded-xl font-black uppercase text-[10px] tracking-widest">{ta.save}</button>
                      <button onClick={() => setEditingType(null)} className="px-5 py-2 bg-slate-100 text-slate-500 rounded-xl font-black uppercase text-[10px]">{ta.cancel}</button>
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
                <p className="text-[8px] font-black uppercase text-red-600 tracking-widest mb-3">{ta.headings}</p>
                <div className="space-y-3">
                  {(['ru', 'en', 'es'] as const).map(l => (
                    <div key={l}>
                      <label className="text-[8px] font-black uppercase text-slate-400 ml-2">{l} {ta.heading}</label>
                      <input type="text" className="w-full bg-slate-50 border border-slate-100 rounded-2xl px-4 py-3 text-xs font-bold focus:border-red-600 outline-none"
                        value={editingItem.title?.[l] || ''}
                        onChange={e => setEditingItem({...editingItem, title: {...editingItem.title!, [l]: e.target.value}})} />
                    </div>
                  ))}
                </div>
              </div>

              {/* Descriptions */}
              <div>
                <p className="text-[8px] font-black uppercase text-red-600 tracking-widest mb-3">{ta.descriptionsLabel}</p>
                <div className="space-y-3">
                  {(['ru', 'en', 'es'] as const).map(l => (
                    <div key={l}>
                      <label className="text-[8px] font-black uppercase text-slate-400 ml-2">{l} {ta.descriptionWord}</label>
                      <textarea rows={3} className="w-full bg-slate-50 border border-slate-100 rounded-2xl px-4 py-3 text-xs font-medium focus:border-red-600 outline-none resize-none"
                        value={editingItem.description?.[l] || ''}
                        onChange={e => setEditingItem({...editingItem, description: {...(editingItem.description || {en:'',ru:'',es:''}), [l]: e.target.value}})} />
                    </div>
                  ))}
                </div>
              </div>

              {/* Info */}
              <div>
                <p className="text-[8px] font-black uppercase text-red-600 tracking-widest mb-3">{ta.basics}</p>
                <div className="space-y-3">
                  <div className="flex gap-3">
                    <div className="flex-1">
                      <label className="text-[8px] font-black uppercase text-slate-400 ml-2">{ta.typeLabel}</label>
                      <select className="w-full bg-slate-50 border border-slate-100 rounded-2xl px-4 py-3 text-xs font-bold focus:border-red-600 outline-none"
                        value={editingItem.type || ''} onChange={e => setEditingItem({...editingItem, type: e.target.value})}>
                        {db.customTypes.map(tp => <option key={tp.id} value={tp.id}>{tp[lang] || tp.ru || tp.en}</option>)}
                      </select>
                    </div>
                    <div className="flex-1">
                      <label className="text-[8px] font-black uppercase text-slate-400 ml-2">{ta.authorLabel}</label>
                      <input type="text" className="w-full bg-slate-50 border border-slate-100 rounded-2xl px-4 py-3 text-xs font-bold focus:border-red-600 outline-none"
                        value={editingItem.author || ''} onChange={e => setEditingItem({...editingItem, author: e.target.value})} />
                    </div>
                  </div>
                  <div className="flex flex-col sm:flex-row gap-3">
                    <div className="flex-1">
                      <div className="flex items-center justify-between ml-2 mb-1">
                        <label className="text-[8px] font-black uppercase text-slate-400">{ta.pubDate}</label>
                        <div className="flex gap-0.5 bg-slate-100 rounded-lg p-0.5">
                          <button type="button"
                            onClick={() => {
                              setPubDateMode('date');
                              const v = editingItem.publishedDate || '';
                              const next = /^\d{4}$/.test(v) ? `${v}-01-01` : (v || new Date().toISOString().split('T')[0]);
                              setEditingItem({ ...editingItem, publishedDate: next });
                            }}
                            className={`px-2 py-1 rounded-md text-[8px] font-black uppercase tracking-wider transition-colors ${pubDateMode === 'date' ? 'bg-white text-red-600 shadow-sm' : 'text-slate-400'}`}>
                            {ta.pubModeDate}
                          </button>
                          <button type="button"
                            onClick={() => {
                              setPubDateMode('year');
                              const v = editingItem.publishedDate || '';
                              const next = v.match(/^(\d{4})/)?.[1] || String(new Date().getFullYear());
                              setEditingItem({ ...editingItem, publishedDate: next });
                            }}
                            className={`px-2 py-1 rounded-md text-[8px] font-black uppercase tracking-wider transition-colors ${pubDateMode === 'year' ? 'bg-white text-red-600 shadow-sm' : 'text-slate-400'}`}>
                            {ta.pubModeYear}
                          </button>
                        </div>
                      </div>
                      {pubDateMode === 'year' ? (
                        <input type="number" min="1000" max="2100" step="1" placeholder="2021"
                          className="w-full bg-slate-50 border border-slate-100 rounded-2xl px-4 py-3 text-xs font-bold focus:border-red-600 outline-none"
                          value={editingItem.publishedDate || ''} onChange={e => setEditingItem({ ...editingItem, publishedDate: e.target.value })} />
                      ) : (
                        <input type="date"
                          className="w-full bg-slate-50 border border-slate-100 rounded-2xl px-4 py-3 text-xs font-bold focus:border-red-600 outline-none"
                          value={editingItem.publishedDate || ''} onChange={e => setEditingItem({ ...editingItem, publishedDate: e.target.value })} />
                      )}
                    </div>
                    <div className="flex-1">
                      <label className="text-[8px] font-black uppercase text-slate-400 ml-2">{ta.editorialRating}</label>
                      <input type="number" min="0" max="5" step="0.1" className="w-full bg-slate-50 border border-slate-100 rounded-2xl px-4 py-3 text-xs font-bold focus:border-red-600 outline-none"
                        value={editingItem.rating ?? 0} onChange={e => setEditingItem({...editingItem, rating: parseFloat(e.target.value) || 0})} />
                    </div>
                  </div>
                </div>
              </div>

              {/* Series & Tags */}
              <div>
                <p className="text-[8px] font-black uppercase text-red-600 tracking-widest mb-3">{ta.seriesAndTags}</p>
                <div className="space-y-3">
                  <div className="flex gap-3">
                    <div className="flex-1">
                      <label className="text-[8px] font-black uppercase text-slate-400 ml-2">{ta.seriesName}</label>
                      <input type="text" placeholder={ta.seriesNamePh} className="w-full bg-slate-50 border border-slate-100 rounded-2xl px-4 py-3 text-xs font-bold focus:border-red-600 outline-none"
                        value={editingItem.series || ''} onChange={e => setEditingItem({...editingItem, series: e.target.value})}
                        list="series-suggestions" />
                      <datalist id="series-suggestions">
                        {Array.from(new Set(db.items.map(i => i.series).filter(Boolean))).map(s => (
                          <option key={s} value={s} />
                        ))}
                      </datalist>
                    </div>
                    <div className="w-24">
                      <label className="text-[8px] font-black uppercase text-slate-400 ml-2">{ta.seriesOrder}</label>
                      <input type="number" min="1" step="1" placeholder="1" className="w-full bg-slate-50 border border-slate-100 rounded-2xl px-4 py-3 text-xs font-bold focus:border-red-600 outline-none"
                        value={editingItem.seriesOrder ?? ''} onChange={e => setEditingItem({...editingItem, seriesOrder: e.target.value ? parseInt(e.target.value) : undefined})} />
                    </div>
                  </div>
                  <div>
                    <label className="text-[8px] font-black uppercase text-slate-400 ml-2">{ta.tagsLabel}</label>
                    <input type="text" placeholder={ta.tagsPlaceholder} className="w-full bg-slate-50 border border-slate-100 rounded-2xl px-4 py-3 text-xs font-bold focus:border-red-600 outline-none"
                      value={(editingItem.tags || []).join(', ')} onChange={e => handleTagsChange(e.target.value)} />
                    {(editingItem.tags || []).length > 0 && (
                      <div className="flex flex-wrap gap-1.5 mt-2">
                        {(editingItem.tags || []).map(tag => (
                          <span key={tag} className="px-2.5 py-1 rounded-lg bg-slate-100 text-slate-700 text-[10px] font-bold">#{tag}</span>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {/* Articles (external web articles / social posts) */}
              <div className="border-2 border-dashed border-red-200 bg-red-50/40 rounded-3xl p-4">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <div className="p-1.5 bg-red-600 rounded-lg text-white"><Newspaper size={14} /></div>
                    <p className="text-[11px] font-black uppercase text-red-600 tracking-widest">{ta.articlesLabel}</p>
                  </div>
                  <button
                    type="button"
                    onClick={handleAddArticle}
                    className="flex items-center gap-1.5 text-[10px] font-black uppercase bg-red-600 text-white px-3 py-2 rounded-xl shadow-md shadow-red-200 hover:bg-red-700 active:scale-95 transition-all"
                  >
                    <PlusIcon size={12} strokeWidth={3} /> {ta.addArticle}
                  </button>
                </div>
                <p className="text-[10px] text-slate-500 leading-relaxed mb-3">{ta.articlesHelp}</p>
                <div className="space-y-2">
                  {(editingItem.articles || []).map(a => {
                    const presets = ['Web', 'Twitter', 'X', 'YandexZen', 'VK', 'Telegram'];
                    const isCustom = !presets.includes(a.source);
                    return (
                      <div key={a.id} className="relative p-2.5 pl-9 bg-white rounded-2xl border border-red-100 space-y-2">
                        <button type="button" onClick={() => handleRemoveArticle(a.id)} className="absolute top-2.5 left-2 p-1 text-slate-300 hover:text-red-500"><X size={14} /></button>
                        <div className="flex flex-wrap items-center gap-2">
                          <select
                            value={isCustom ? '__custom__' : a.source}
                            onChange={e => handleUpdateArticle(a.id, 'source', e.target.value === '__custom__' ? '' : e.target.value)}
                            className="bg-white border border-slate-200 rounded-xl px-3 py-2 text-[11px] font-bold focus:border-red-600 outline-none">
                            {presets.map(p => <option key={p} value={p}>{p}</option>)}
                            <option value="__custom__">{ta.customSource}</option>
                          </select>
                          <select
                            value={a.language || 'ru'}
                            onChange={e => handleUpdateArticle(a.id, 'language', e.target.value)}
                            className="bg-white border border-slate-200 rounded-xl px-3 py-2 text-[11px] font-bold focus:border-red-600 outline-none">
                            <option value="ru">RU</option><option value="en">EN</option><option value="es">ES</option>
                            <option value="it">IT</option><option value="fr">FR</option><option value="de">DE</option>
                          </select>
                          {isCustom && (
                            <input type="text" placeholder={ta.sourceName} className="flex-1 min-w-0 bg-white border border-slate-200 rounded-xl px-3 py-2 text-[11px] font-bold focus:border-red-600 outline-none"
                              value={a.source} onChange={e => handleUpdateArticle(a.id, 'source', e.target.value)} />
                          )}
                        </div>
                        <input type="url" placeholder="https://dzen.ru/a/... · https://x.com/user/status/... · https://vk.com/wall..." className="w-full bg-white border border-slate-200 rounded-xl px-3 py-2 text-[11px] font-bold focus:border-red-600 outline-none"
                          value={a.url} onChange={e => handleUpdateArticle(a.id, 'url', e.target.value)} />
                        <input type="text" placeholder={ta.articleTitlePh} className="w-full bg-white border border-slate-200 rounded-xl px-3 py-2 text-[11px] font-bold focus:border-red-600 outline-none"
                          value={a.title || ''} onChange={e => handleUpdateArticle(a.id, 'title', e.target.value)} />
                      </div>
                    );
                  })}
                  {(!editingItem.articles || editingItem.articles.length === 0) && (
                    <button
                      type="button"
                      onClick={handleAddArticle}
                      className="w-full py-4 border-2 border-dashed border-red-300 rounded-2xl text-[10px] font-black uppercase tracking-widest text-red-500 hover:bg-red-100 hover:border-red-400 transition-colors flex items-center justify-center gap-2"
                    >
                      <PlusIcon size={14} strokeWidth={3} /> {ta.addFirstArticle}
                    </button>
                  )}
                </div>
              </div>

              {/* Media */}
              <div>
                <p className="text-[8px] font-black uppercase text-red-600 tracking-widest mb-3">{ta.media}</p>
                <div className="space-y-3">
                  <div>
                    <label className="text-[8px] font-black uppercase text-slate-400 ml-2">{ta.cover}</label>
                    <div className="flex gap-2">
                      <input type="text" placeholder="https://..." className="flex-1 bg-slate-50 border border-slate-100 rounded-2xl px-4 py-3 text-xs font-bold focus:border-red-600 outline-none"
                        value={editingItem.coverUrl || ''} onChange={e => setEditingItem({...editingItem, coverUrl: e.target.value})} />
                      <button type="button"
                        onClick={() => coverInputRef.current?.click()}
                        disabled={uploadState?.field === 'cover' || !!stagedCoverFile}
                        title={ta.chooseFile}
                        className="px-3 bg-slate-100 rounded-2xl text-slate-500 hover:bg-red-50 hover:text-red-600 transition-colors disabled:opacity-40 shrink-0">
                        <Upload size={16} />
                      </button>
                    </div>
                    {stagedCoverFile && !uploadState && (
                      <div className="mt-2 flex items-center gap-2 p-2 bg-blue-50 rounded-xl border border-blue-100">
                        <span className="text-[9px] font-bold text-blue-700 flex-1 truncate">{stagedCoverFile.name} ({formatFileSize(stagedCoverFile.size)})</span>
                        <button type="button" onClick={() => editingItem?.id && uploadCover(editingItem.id)} className="px-3 py-1 bg-blue-600 text-white text-[9px] font-black rounded-lg shrink-0">{ta.uploadBtn}</button>
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
                    <div className="flex items-center justify-between mb-2">
                      <label className="text-[8px] font-black uppercase text-slate-400 ml-2 flex items-center gap-1.5"><Video size={11} /> {ta.videoContent}</label>
                      <button type="button" onClick={handleAddVideo} className="text-[9px] font-black uppercase bg-red-50 text-red-600 px-3 py-1.5 rounded-xl border border-red-100 hover:bg-red-100 transition-colors">{ta.addVideo}</button>
                    </div>
                    <div className="space-y-2">
                      {(editingItem.videos || []).map(v => {
                        const presets = ['YouTube', 'RuTube', 'Twitch', 'VK'];
                        const isCustom = !presets.includes(v.source);
                        return (
                          <div key={v.id} className="relative p-2.5 pl-9 bg-slate-50 rounded-2xl border border-slate-100 space-y-2">
                            <button type="button" onClick={() => handleRemoveVideo(v.id)} className="absolute top-2.5 left-2 p-1 text-slate-300 hover:text-red-500"><X size={14} /></button>
                            <div className="flex flex-wrap items-center gap-2">
                              <div className="relative">
                                <select
                                  value={isCustom ? '__custom__' : v.source}
                                  onChange={e => handleUpdateVideo(v.id, 'source', e.target.value === '__custom__' ? '' : e.target.value)}
                                  className="appearance-none bg-white border border-slate-200 rounded-xl pl-3 pr-8 py-2 text-[11px] font-bold focus:border-red-600 outline-none">
                                  {presets.map(p => <option key={p} value={p}>{p}</option>)}
                                  <option value="__custom__">{ta.customSource}</option>
                                </select>
                                <ChevronDown size={14} className="absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none text-slate-400" />
                              </div>
                              <div className="relative">
                                <select
                                  value={v.language || 'ru'}
                                  onChange={e => handleUpdateVideo(v.id, 'language', e.target.value)}
                                  className="appearance-none bg-white border border-slate-200 rounded-xl pl-3 pr-8 py-2 text-[11px] font-bold focus:border-red-600 outline-none">
                                  <option value="ru">RU</option>
                                  <option value="en">EN</option>
                                  <option value="es">ES</option>
                                  <option value="it">IT</option>
                                  <option value="fr">FR</option>
                                  <option value="de">DE</option>
                                </select>
                                <ChevronDown size={14} className="absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none text-slate-400" />
                              </div>
                              {isCustom && (
                                <input type="text" placeholder={ta.sourceName} className="flex-1 min-w-0 bg-white border border-slate-200 rounded-xl px-3 py-2 text-[11px] font-bold focus:border-red-600 outline-none"
                                  value={v.source} onChange={e => handleUpdateVideo(v.id, 'source', e.target.value)} />
                              )}
                            </div>
                            <input type="text" placeholder="https://youtube.com/watch?v=..." className="w-full bg-white border border-slate-200 rounded-xl px-3 py-2 text-[11px] font-bold focus:border-red-600 outline-none"
                              value={v.url} onChange={e => handleUpdateVideo(v.id, 'url', e.target.value)} />
                          </div>
                        );
                      })}
                      {(!editingItem.videos || editingItem.videos.length === 0) && (
                        <p className="text-[9px] text-slate-300 font-bold uppercase tracking-widest text-center py-3">{ta.noVideo}</p>
                      )}
                    </div>
                  </div>
                </div>
              </div>

              {/* Content Languages */}
              <div>
                <p className="text-[8px] font-black uppercase text-red-600 tracking-widest mb-3">{ta.contentLangs}</p>
                <div className="grid grid-cols-3 gap-2">
                  {(['ru', 'en', 'es', 'it', 'fr', 'de'] as const).map(l => {
                    const active = (editingItem.contentLanguages || []).includes(l);
                    return (
                      <button key={l} type="button" onClick={() => handleToggleContentLang(l)}
                        className={`py-3 rounded-xl text-[10px] font-black uppercase tracking-widest border transition-all ${active ? 'bg-slate-900 text-white border-slate-900' : 'bg-slate-50 text-slate-400 border-slate-100 hover:border-slate-300'}`}>
                        {l}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Access */}
              <div>
                <p className="text-[8px] font-black uppercase text-red-600 tracking-widest mb-3">{ta.accessRights}</p>
                <div className="space-y-2">
                  {([
                    { key: 'isPrivate' as const,      label: ta.whitelistOnly },
                    { key: 'allowDownload' as const,  label: ta.allowDownloadLabel },
                    { key: 'allowReading' as const,   label: ta.allowReadingLabel },
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
                  <p className="text-[8px] font-black uppercase text-red-600 tracking-widest">{ta.files}</p>
                  <button onClick={handleAddFormat} className="text-[9px] font-black uppercase bg-red-50 text-red-600 px-3 py-1.5 rounded-xl border border-red-100 hover:bg-red-100 transition-colors">{ta.addFile}</button>
                </div>
                <div className="space-y-3">
                  {editingItem.formats && editingItem.formats.map((f) => (
                    <div key={f.id} className="relative p-3 pl-9 bg-slate-50 rounded-2xl border border-slate-100">
                      <button
                        type="button"
                        onClick={() => { if (!f.url) handleRemoveFormat(f.id); }}
                        disabled={!!f.url}
                        title={f.url ? ta.fileUploadedHint : ta.removeBlock}
                        className={`absolute top-3 left-2 p-1 ${f.url ? 'text-slate-200 cursor-not-allowed' : 'text-slate-300 hover:text-red-500'}`}>
                        <X size={14} />
                      </button>
                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <label className="text-[7px] font-black uppercase text-slate-400 ml-1">{ta.nameLabel}</label>
                          <input placeholder="PDF / EPUB / …" className="w-full bg-white border border-slate-200 rounded-lg px-2 py-1.5 text-[9px] font-bold outline-none focus:border-red-400"
                            value={f.name} onChange={e => handleUpdateFormat(f.id, 'name', e.target.value)} />
                        </div>
                        <div>
                          <label className="text-[7px] font-black uppercase text-slate-400 ml-1">{ta.langLabel}</label>
                          <select className="w-full bg-white border border-slate-200 rounded-lg px-2 py-1.5 text-[9px] font-bold outline-none focus:border-red-400"
                            value={f.language || 'ru'} onChange={e => handleUpdateFormat(f.id, 'language', e.target.value as any)}>
                            <option value="ru">RU</option>
                            <option value="en">EN</option>
                            <option value="es">ES</option>
                            <option value="it">IT</option>
                            <option value="fr">FR</option>
                            <option value="de">DE</option>
                          </select>
                        </div>
                        <div className="col-span-2">
                          <label className="text-[7px] font-black uppercase text-slate-400 ml-1">{ta.fileUrl}</label>
                          <div className="flex gap-1">
                            <input placeholder="https://..." className="flex-1 min-w-0 bg-white border border-slate-200 rounded-lg px-2 py-1.5 text-[9px] font-bold outline-none focus:border-red-400"
                              value={f.url} onChange={e => handleUpdateFormat(f.id, 'url', e.target.value)} />
                            <button type="button"
                              onClick={() => { uploadingFormatId.current = f.id; fileInputRef.current?.click(); }}
                              disabled={uploadState !== null || !!stagedContentFile}
                              title={ta.chooseFile}
                              className="px-2 bg-slate-100 rounded-lg text-slate-500 hover:bg-red-50 hover:text-red-600 transition-colors disabled:opacity-40 shrink-0">
                              <Upload size={12} />
                            </button>
                          </div>
                          {stagedContentFile?.formatId === f.id && !uploadState && (
                            <div className="mt-1 flex items-center gap-1.5 p-1.5 bg-blue-50 rounded-lg border border-blue-100">
                              <span className="text-[8px] font-bold text-blue-700 flex-1 truncate">{stagedContentFile.file.name} ({formatFileSize(stagedContentFile.file.size)})</span>
                              <button type="button" onClick={() => editingItem?.id && uploadContentFile(editingItem.id, f.id, f.language || 'ru')} className="px-2 py-0.5 bg-blue-600 text-white text-[8px] font-black rounded shrink-0">{ta.uploadBtn}</button>
                              <button type="button" onClick={() => { setStagedContentFile(null); if (fileInputRef.current) fileInputRef.current.value = ''; }} className="text-blue-400 hover:text-red-500 shrink-0"><X size={10} /></button>
                            </div>
                          )}
                          {uploadState?.field === f.id && (
                            <div className="mt-1.5">
                              <div className="flex items-center justify-between mb-1">
                                <span className="text-[8px] font-black uppercase text-red-600 tracking-widest">{uploadState.progress < 100 ? ta.uploading : ta.processing}</span>
                                <span className="text-[8px] font-black text-slate-500 tabular-nums">{uploadState.progress}%</span>
                              </div>
                              <div className="bg-slate-200 rounded-full h-2 overflow-hidden">
                                <div className="bg-red-600 h-2 rounded-full transition-all duration-200" style={{ width: `${uploadState.progress}%` }} />
                              </div>
                            </div>
                          )}
                        </div>
                        <div>
                          <label className="text-[7px] font-black uppercase text-slate-400 ml-1">{ta.sizeLabel}</label>
                          <input placeholder="2.4 MB" className="w-full bg-white border border-slate-200 rounded-lg px-2 py-1.5 text-[9px] font-bold outline-none focus:border-red-400"
                            value={f.size || ''} onChange={e => handleUpdateFormat(f.id, 'size', e.target.value)} />
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => handleDeleteFormat(f)}
                        className="mt-2 w-full py-2 bg-red-50 text-red-500 rounded-xl text-[9px] font-black uppercase tracking-widest hover:bg-red-600 hover:text-white transition-colors flex items-center justify-center gap-1.5"
                      >
                        <Trash2 size={11} /> {ta.deleteFileServer}
                      </button>
                    </div>
                  ))}
                  {(!editingItem.formats || editingItem.formats.length === 0) && (
                    <p className="text-center text-[9px] text-slate-300 font-bold uppercase py-3">{ta.noFiles}</p>
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
               <button onClick={handleSaveItem} className="w-full py-4 bg-red-600 text-white rounded-2xl font-black uppercase tracking-widest shadow-xl shadow-red-200">{ta.saveAsset}</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Restore confirmation modal ─────────────────────────────────────── */}
      {restoreTarget && (
        <div className="fixed inset-0 z-[600] flex items-center justify-center p-6 bg-black/50 backdrop-blur-sm">
          <div className="w-full max-w-md bg-white rounded-3xl shadow-2xl p-6">
            <div className="w-12 h-12 rounded-2xl bg-amber-50 flex items-center justify-center mb-4">
              <RotateCcw size={22} className="text-amber-600" />
            </div>
            <h3 className="text-base font-black text-slate-900 mb-1">{ta.backupRestoreConfirm}</h3>
            <p className="text-xs text-slate-500 leading-relaxed mb-2">{ta.backupRestoreDesc}</p>
            <p className="text-xs font-mono font-bold text-slate-700 truncate mb-4 bg-slate-50 p-2 rounded-lg">{restoreTarget}</p>
            <label className="text-[8px] font-black uppercase tracking-widest text-slate-400 mb-2 block">{ta.backupRestoreConfirmType}</label>
            <input
              autoFocus
              value={restoreConfirm}
              onChange={e => setRestoreConfirm(e.target.value)}
              placeholder="RESTORE"
              className="w-full bg-slate-50 border-2 border-slate-200 rounded-2xl px-4 py-3 text-sm font-bold focus:border-amber-500 outline-none mb-4"
            />
            <div className="flex gap-3">
              <button
                onClick={() => { setRestoreTarget(null); setRestoreConfirm(''); }}
                className="flex-1 py-3 rounded-2xl text-xs font-black uppercase tracking-widest bg-slate-100 text-slate-600 hover:bg-slate-200 transition-colors"
              >
                {ta.cancel}
              </button>
              <button
                onClick={() => triggerRestore(restoreTarget)}
                disabled={restoreConfirm.trim().toUpperCase() !== 'RESTORE' || backupBusy}
                className="flex-1 py-3 rounded-2xl text-xs font-black uppercase tracking-widest bg-amber-600 text-white hover:bg-amber-700 disabled:opacity-40 transition-colors"
              >
                {ta.backupRestore}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Backup config modal ────────────────────────────────────────────── */}
      {showBackupConfig && backupCfgDraft && (
        <div className="fixed inset-0 z-[600] bg-slate-900/40 backdrop-blur-xl flex items-end md:items-center justify-center p-0 md:p-5">
          <div className="bg-white w-full md:max-w-2xl rounded-t-[2rem] md:rounded-[3rem] border border-white shadow-2xl overflow-hidden h-[90vh] md:max-h-[85vh] flex flex-col">
            <div className="p-5 border-b border-slate-100 flex justify-between items-center sticky top-0 bg-white z-10 shrink-0">
              <h3 className="text-base font-black uppercase tracking-tighter">{ta.backupConfigure}</h3>
              <button onClick={() => setShowBackupConfig(false)} className="p-2 bg-slate-50 rounded-full hover:bg-red-50 hover:text-red-600"><X size={20} /></button>
            </div>

            <div className="p-5 overflow-y-auto space-y-6 flex-1">
              {/* Schedule */}
              <div>
                <p className="text-[8px] font-black uppercase text-red-600 tracking-widest mb-3">{ta.backupSchedule}</p>
                <div className="p-4 bg-slate-50 rounded-2xl border border-slate-100 space-y-3">
                  <label className="flex items-center justify-between cursor-pointer">
                    <span className="text-xs font-bold text-slate-700">{ta.backupAutomaticBackups}</span>
                    <div className="relative">
                      <input type="checkbox" className="sr-only peer"
                        checked={!!backupCfgDraft.schedule?.enabled}
                        onChange={e => setBackupCfgDraft({...backupCfgDraft, schedule: {...(backupCfgDraft.schedule || {}), enabled: e.target.checked}})} />
                      <div className="w-10 h-6 bg-slate-200 rounded-full peer peer-checked:bg-red-600 transition-all after:content-[''] after:absolute after:top-[3px] after:left-[3px] after:bg-white after:rounded-full after:h-[18px] after:w-[18px] after:transition-all peer-checked:after:translate-x-4" />
                    </div>
                  </label>
                  <div>
                    <label className="text-[8px] font-black uppercase text-slate-400 ml-1">{ta.backupIntervalHours}</label>
                    <input type="number" min="1" max="168" className="w-full bg-white border border-slate-200 rounded-xl px-3 py-2 text-xs font-bold focus:border-red-500 outline-none"
                      value={backupCfgDraft.schedule?.intervalHours ?? 6}
                      onChange={e => setBackupCfgDraft({...backupCfgDraft, schedule: {...(backupCfgDraft.schedule || {}), intervalHours: parseInt(e.target.value) || 6}})} />
                  </div>
                </div>
              </div>

              {/* Target #1 — Local (active by default) */}
              <div>
                <div className="flex items-center justify-between mb-3">
                  <p className="text-[8px] font-black uppercase text-red-600 tracking-widest flex items-center gap-2">
                    <HardDrive size={11} /> {ta.backupTargetLocal} <span className="text-green-600">●</span>
                  </p>
                  <label className="relative inline-flex items-center cursor-pointer">
                    <input type="checkbox" className="sr-only peer"
                      checked={!!backupCfgDraft.targets?.local?.enabled}
                      onChange={e => setBackupCfgDraft({...backupCfgDraft, targets: {...backupCfgDraft.targets, local: {...(backupCfgDraft.targets?.local || {}), enabled: e.target.checked}}})} />
                    <div className="w-10 h-6 bg-slate-200 rounded-full peer peer-checked:bg-red-600 transition-all after:content-[''] after:absolute after:top-[3px] after:left-[3px] after:bg-white after:rounded-full after:h-[18px] after:w-[18px] after:transition-all peer-checked:after:translate-x-4" />
                  </label>
                </div>
                <p className="text-[10px] text-slate-400 leading-relaxed">{ta.backupLocalDesc}</p>
              </div>

              {/* Target #2 — Remote VPS (disabled by default) */}
              <div className="opacity-90">
                <div className="flex items-center justify-between mb-3">
                  <p className="text-[8px] font-black uppercase text-red-600 tracking-widest flex items-center gap-2">
                    <Server size={11} /> {ta.backupTargetRemote} <span className="text-slate-300">●</span>
                  </p>
                  <label className="relative inline-flex items-center cursor-pointer">
                    <input type="checkbox" className="sr-only peer"
                      checked={!!backupCfgDraft.targets?.remote?.enabled}
                      onChange={e => setBackupCfgDraft({...backupCfgDraft, targets: {...backupCfgDraft.targets, remote: {...(backupCfgDraft.targets?.remote || {}), enabled: e.target.checked}}})} />
                    <div className="w-10 h-6 bg-slate-200 rounded-full peer peer-checked:bg-red-600 transition-all after:content-[''] after:absolute after:top-[3px] after:left-[3px] after:bg-white after:rounded-full after:h-[18px] after:w-[18px] after:transition-all peer-checked:after:translate-x-4" />
                  </label>
                </div>
                <p className="text-[10px] text-slate-400 leading-relaxed mb-3">{ta.backupRemoteDesc}</p>
                <div className="space-y-2 p-3 bg-slate-50 rounded-2xl border border-slate-100">
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="text-[8px] font-black uppercase text-slate-400 ml-1">{ta.backupRemoteHost}</label>
                      <input type="text" placeholder="backup.example.com" className="w-full bg-white border border-slate-200 rounded-lg px-2 py-2 text-[11px] font-bold focus:border-red-500 outline-none"
                        value={backupCfgDraft.targets?.remote?.host || ''}
                        onChange={e => setBackupCfgDraft({...backupCfgDraft, targets: {...backupCfgDraft.targets, remote: {...(backupCfgDraft.targets?.remote || {}), host: e.target.value}}})} />
                    </div>
                    <div>
                      <label className="text-[8px] font-black uppercase text-slate-400 ml-1">{ta.backupRemoteUser}</label>
                      <input type="text" placeholder="backup" className="w-full bg-white border border-slate-200 rounded-lg px-2 py-2 text-[11px] font-bold focus:border-red-500 outline-none"
                        value={backupCfgDraft.targets?.remote?.user || ''}
                        onChange={e => setBackupCfgDraft({...backupCfgDraft, targets: {...backupCfgDraft.targets, remote: {...(backupCfgDraft.targets?.remote || {}), user: e.target.value}}})} />
                    </div>
                  </div>
                  <div>
                    <label className="text-[8px] font-black uppercase text-slate-400 ml-1">{ta.backupRemotePath}</label>
                    <input type="text" placeholder="/var/backups/library" className="w-full bg-white border border-slate-200 rounded-lg px-2 py-2 text-[11px] font-bold focus:border-red-500 outline-none"
                      value={backupCfgDraft.targets?.remote?.path || ''}
                      onChange={e => setBackupCfgDraft({...backupCfgDraft, targets: {...backupCfgDraft.targets, remote: {...(backupCfgDraft.targets?.remote || {}), path: e.target.value}}})} />
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    <div className="col-span-2">
                      <label className="text-[8px] font-black uppercase text-slate-400 ml-1">{ta.backupRemoteKeyPath}</label>
                      <input type="text" placeholder="/root/.ssh/id_ed25519" className="w-full bg-white border border-slate-200 rounded-lg px-2 py-2 text-[11px] font-bold focus:border-red-500 outline-none"
                        value={backupCfgDraft.targets?.remote?.sshKeyPath || ''}
                        onChange={e => setBackupCfgDraft({...backupCfgDraft, targets: {...backupCfgDraft.targets, remote: {...(backupCfgDraft.targets?.remote || {}), sshKeyPath: e.target.value}}})} />
                    </div>
                    <div>
                      <label className="text-[8px] font-black uppercase text-slate-400 ml-1">{ta.backupRemotePort}</label>
                      <input type="number" placeholder="22" className="w-full bg-white border border-slate-200 rounded-lg px-2 py-2 text-[11px] font-bold focus:border-red-500 outline-none"
                        value={backupCfgDraft.targets?.remote?.port ?? 22}
                        onChange={e => setBackupCfgDraft({...backupCfgDraft, targets: {...backupCfgDraft.targets, remote: {...(backupCfgDraft.targets?.remote || {}), port: parseInt(e.target.value) || 22}}})} />
                    </div>
                  </div>
                </div>
              </div>

              {/* Target #3 — S3 (disabled by default) */}
              <div className="opacity-90">
                <div className="flex items-center justify-between mb-3">
                  <p className="text-[8px] font-black uppercase text-red-600 tracking-widest flex items-center gap-2">
                    <Cloud size={11} /> {ta.backupTargetS3} <span className="text-slate-300">●</span>
                  </p>
                  <label className="relative inline-flex items-center cursor-pointer">
                    <input type="checkbox" className="sr-only peer"
                      checked={!!backupCfgDraft.targets?.s3?.enabled}
                      onChange={e => setBackupCfgDraft({...backupCfgDraft, targets: {...backupCfgDraft.targets, s3: {...(backupCfgDraft.targets?.s3 || {}), enabled: e.target.checked}}})} />
                    <div className="w-10 h-6 bg-slate-200 rounded-full peer peer-checked:bg-red-600 transition-all after:content-[''] after:absolute after:top-[3px] after:left-[3px] after:bg-white after:rounded-full after:h-[18px] after:w-[18px] after:transition-all peer-checked:after:translate-x-4" />
                  </label>
                </div>
                <p className="text-[10px] text-slate-400 leading-relaxed mb-3">{ta.backupS3Desc}</p>
                <div className="space-y-2 p-3 bg-slate-50 rounded-2xl border border-slate-100">
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="text-[8px] font-black uppercase text-slate-400 ml-1">{ta.backupS3Endpoint}</label>
                      <input type="text" placeholder="https://storage.yandexcloud.net" className="w-full bg-white border border-slate-200 rounded-lg px-2 py-2 text-[11px] font-bold focus:border-red-500 outline-none"
                        value={backupCfgDraft.targets?.s3?.endpoint || ''}
                        onChange={e => setBackupCfgDraft({...backupCfgDraft, targets: {...backupCfgDraft.targets, s3: {...(backupCfgDraft.targets?.s3 || {}), endpoint: e.target.value}}})} />
                    </div>
                    <div>
                      <label className="text-[8px] font-black uppercase text-slate-400 ml-1">{ta.backupS3Region}</label>
                      <input type="text" placeholder="ru-central1" className="w-full bg-white border border-slate-200 rounded-lg px-2 py-2 text-[11px] font-bold focus:border-red-500 outline-none"
                        value={backupCfgDraft.targets?.s3?.region || ''}
                        onChange={e => setBackupCfgDraft({...backupCfgDraft, targets: {...backupCfgDraft.targets, s3: {...(backupCfgDraft.targets?.s3 || {}), region: e.target.value}}})} />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="text-[8px] font-black uppercase text-slate-400 ml-1">{ta.backupS3Bucket}</label>
                      <input type="text" placeholder="library-backups" className="w-full bg-white border border-slate-200 rounded-lg px-2 py-2 text-[11px] font-bold focus:border-red-500 outline-none"
                        value={backupCfgDraft.targets?.s3?.bucket || ''}
                        onChange={e => setBackupCfgDraft({...backupCfgDraft, targets: {...backupCfgDraft.targets, s3: {...(backupCfgDraft.targets?.s3 || {}), bucket: e.target.value}}})} />
                    </div>
                    <div>
                      <label className="text-[8px] font-black uppercase text-slate-400 ml-1">{ta.backupS3Prefix}</label>
                      <input type="text" placeholder="prod/" className="w-full bg-white border border-slate-200 rounded-lg px-2 py-2 text-[11px] font-bold focus:border-red-500 outline-none"
                        value={backupCfgDraft.targets?.s3?.prefix || ''}
                        onChange={e => setBackupCfgDraft({...backupCfgDraft, targets: {...backupCfgDraft.targets, s3: {...(backupCfgDraft.targets?.s3 || {}), prefix: e.target.value}}})} />
                    </div>
                  </div>
                  <div>
                    <label className="text-[8px] font-black uppercase text-slate-400 ml-1">{ta.backupS3AccessKey}</label>
                    <input type="text" placeholder={backupCfgDraft.targets?.s3?.accessKey === '***' ? ta.backupS3SecretSet : 'AKIA...'} className="w-full bg-white border border-slate-200 rounded-lg px-2 py-2 text-[11px] font-mono font-bold focus:border-red-500 outline-none"
                      value={backupCfgDraft.targets?.s3?.accessKey === '***' ? '' : (backupCfgDraft.targets?.s3?.accessKey || '')}
                      onChange={e => setBackupCfgDraft({...backupCfgDraft, targets: {...backupCfgDraft.targets, s3: {...(backupCfgDraft.targets?.s3 || {}), accessKey: e.target.value}}})} />
                  </div>
                  <div>
                    <label className="text-[8px] font-black uppercase text-slate-400 ml-1">{ta.backupS3SecretKey}</label>
                    <input type="password" placeholder={backupCfgDraft.targets?.s3?.secretKey === '***' ? ta.backupS3SecretSet : '••••••••'} className="w-full bg-white border border-slate-200 rounded-lg px-2 py-2 text-[11px] font-mono font-bold focus:border-red-500 outline-none"
                      value={backupCfgDraft.targets?.s3?.secretKey === '***' ? '' : (backupCfgDraft.targets?.s3?.secretKey || '')}
                      onChange={e => setBackupCfgDraft({...backupCfgDraft, targets: {...backupCfgDraft.targets, s3: {...(backupCfgDraft.targets?.s3 || {}), secretKey: e.target.value}}})} />
                  </div>
                </div>
              </div>

              <p className="text-[9px] text-slate-400 italic leading-relaxed">{ta.backupSecretsNotice}</p>
            </div>

            <div className="p-4 bg-slate-50 border-t border-slate-100 flex gap-3">
              <button onClick={() => setShowBackupConfig(false)} className="flex-1 py-3 bg-slate-100 text-slate-600 rounded-2xl text-xs font-black uppercase tracking-widest hover:bg-slate-200 transition-colors">
                {ta.cancel}
              </button>
              <button onClick={saveBackupConfig} disabled={backupBusy} className="flex-1 py-3 bg-red-600 text-white rounded-2xl text-xs font-black uppercase tracking-widest shadow-md hover:bg-red-700 disabled:opacity-40 transition-colors">
                {ta.save}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Delete confirmation modal ──────────────────────────────────────── */}
      {itemToDelete && (
        <div className="fixed inset-0 z-[600] flex items-center justify-center p-6 bg-black/50 backdrop-blur-sm animate-in fade-in duration-200">
          <div className="w-full max-w-sm bg-white dark:bg-[#1c1c1e] rounded-3xl shadow-2xl p-6 animate-in zoom-in-95 duration-200">
            <div className="w-12 h-12 rounded-2xl bg-red-50 dark:bg-red-600/10 flex items-center justify-center mb-4">
              <Trash2 size={22} className="text-red-600" />
            </div>
            <h3 className="text-base font-black text-slate-900 dark:text-white mb-1">{ta.confirmDeleteItem}</h3>
            <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed mb-2">{ta.confirmDeleteItemDesc}</p>
            <p className="text-xs font-bold text-slate-700 dark:text-slate-200 truncate mb-6">«{typeof itemToDelete.title === 'object' ? (itemToDelete.title[lang] || itemToDelete.title.en || itemToDelete.title.ru) : itemToDelete.title}»</p>
            <div className="flex gap-3">
              <button
                onClick={() => setItemToDelete(null)}
                className="flex-1 py-3 rounded-2xl text-xs font-black uppercase tracking-widest bg-slate-100 dark:bg-white/10 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-white/15 transition-colors"
              >
                {ta.cancel}
              </button>
              <button
                onClick={async () => {
                  const id = itemToDelete.id;
                  setItemToDelete(null);
                  try {
                    await deleteItem(id);
                    toast.success(ta.itemDeleted);
                  } catch { /* error already toasted by db layer */ }
                  onUpdate();
                }}
                className="flex-1 py-3 rounded-2xl text-xs font-black uppercase tracking-widest bg-red-600 text-white hover:bg-red-700 transition-colors"
              >
                {ta.deleteConfirm}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default Admin;
