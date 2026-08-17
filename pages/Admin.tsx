
import React, { useState, useMemo, useRef, useEffect } from 'react';
import { AppState, MediaItem, Locale, ContentLang, FileFormat, CustomType, VideoLink, ArticleLink } from '../types';
import {
  Plus, Edit2, Trash2, Users, Eye, Download, LogOut, Tags,
  ShieldCheck, X, AtSign, Unlock, Lock,
  Percent, Database, Upload, Video,
  Ban, ShieldAlert, Monitor, MousePointer2, Trophy, BarChart4,
  ChevronDown, RefreshCw, GitBranch, CheckCircle2, AlertCircle,
  HardDrive, Cloud, Server, Save, RotateCcw, Settings, Newspaper, Plus as PlusIcon,
  ScanLine, Play, Square
} from 'lucide-react';
import { updateItem, deleteItem, saveDb, addUserToWhitelist, removeUserFromWhitelist, toggleGlobalAccess, addCustomType, deleteCustomType, updateCustomType, addToBlacklist, removeFromBlacklist, resetStats, resetTrafficStats, addAnalyticsExcludeUsername, removeAnalyticsExcludeUsername, addAnalyticsExcludeIp, removeAnalyticsExcludeIp, addAnalyticsExcludeUserId, removeAnalyticsExcludeUserId, registerBrowserExclude, removeBrowserExclude, getSkipAnalyticsToken, loadAnalytics, purgeExcludedVisits, lookupDoi, addAnalyticsExcludeVisitor, removeAnalyticsExcludeVisitor, loadErrorLog, clearErrorLog, eraseUserData, getServerApiKey, setServerApiKey, loadContentScan, startContentScan, stopContentScan, loadIndexReport, startIndexing, stopIndexing, loadIndexPages, savePageText, loadJobs, queueSubtitles, jobAction, cancelBatch, unindexItem, queueTranscribe, clearJobHistory, loadSearchStats } from '../services/db';
import type { ErrorLogRow, ContentScanReport, ContentScanRow, ContentScanState, IndexReport, IndexRow, IndexPage, JobRow, JobTotals, TranscribeMethod, SearchStats } from '../services/db';
import {
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  AreaChart, Area
} from 'recharts';
import { pickText, isExternalUrl, isExternallyHosted } from '../utils';
import {
  LICENSE_PRESETS, CUSTOM_LICENSE_CODE, getLicensePreset, licenseForbidsRedistribution,
} from '../services/licenses';
import {
  PUBLICATION_TYPES, getPublicationType, publicationTypeLabel, isValidDoi, normalizeDoi,
} from '../services/publication';
import CardCover from '../components/CardCover';
import AuthorsEditor from '../components/AuthorsEditor';
import { toast } from '../services/toast';
import { Search as SearchIcon } from 'lucide-react';

// One collapsible section of the Index tab. The tab holds two jobs — check what
// can be indexed, and index it — and stacking both open makes a wall nobody
// reads. Collapsed sections keep the headline numbers visible and the detail one
// click away.
const Panel: React.FC<{
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  badge?: string;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}> = ({ icon, title, subtitle, badge, open, onToggle, children }) => (
  <div className="bg-white dark:bg-[#1c1c1e] rounded-[2rem] border border-slate-100 dark:border-white/[0.08] shadow-sm overflow-hidden">
    <button
      onClick={onToggle}
      aria-expanded={open}
      className="w-full flex items-center gap-4 p-5 md:p-6 text-left hover:bg-slate-50/70 dark:hover:bg-white/[0.03] transition-colors"
    >
      <div className="p-2.5 bg-red-50 dark:bg-red-600/10 text-red-600 rounded-2xl shrink-0">{icon}</div>
      <div className="min-w-0 flex-1">
        <h3 className="text-xs md:text-sm font-black text-slate-900 dark:text-white uppercase tracking-widest">{title}</h3>
        <p className="text-[9px] font-black text-slate-400 dark:text-slate-500 uppercase tracking-widest mt-1">{subtitle}</p>
      </div>
      {badge && (
        <span className="shrink-0 px-3 py-1.5 rounded-xl bg-slate-100 dark:bg-white/[0.06] text-[10px] font-black text-slate-600 dark:text-slate-300 tabular-nums whitespace-nowrap">
          {badge}
        </span>
      )}
      <ChevronDown size={18} strokeWidth={3} className={`shrink-0 text-slate-300 dark:text-slate-600 transition-transform duration-300 ${open ? 'rotate-180' : ''}`} />
    </button>
    {open && <div className="px-5 md:px-8 pb-6 md:pb-8">{children}</div>}
  </div>
);

// Verdict colours for the recognition tab. Red means "cannot be searched at
// all", amber "worth a look", slate "not this step's problem" — so the two
// things that cost money stand out from the things that don't.
const SCAN_STATE_STYLES: Record<string, string> = {
  text:        'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-400 dark:border-emerald-500/25',
  partial:     'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-500/10 dark:text-amber-400 dark:border-amber-500/25',
  scan:        'bg-red-50 text-red-700 border-red-200 dark:bg-red-500/10 dark:text-red-400 dark:border-red-500/25',
  missing:     'bg-red-50 text-red-700 border-red-200 dark:bg-red-500/10 dark:text-red-400 dark:border-red-500/25',
  nothing:     'bg-red-50 text-red-700 border-red-200 dark:bg-red-500/10 dark:text-red-400 dark:border-red-500/25',
  error:       'bg-red-50 text-red-700 border-red-200 dark:bg-red-500/10 dark:text-red-400 dark:border-red-500/25',
  media:       'bg-slate-100 text-slate-500 border-slate-200 dark:bg-white/5 dark:text-slate-400 dark:border-white/10',
  external:    'bg-slate-100 text-slate-500 border-slate-200 dark:bg-white/5 dark:text-slate-400 dark:border-white/10',
  unsupported: 'bg-slate-100 text-slate-500 border-slate-200 dark:bg-white/5 dark:text-slate-400 dark:border-white/10',
};

// Worst first: the filter row should open on what needs a decision.
const SCAN_STATE_ORDER = ['scan', 'partial', 'error', 'missing', 'nothing', 'unsupported', 'media', 'external', 'text'] as const;

// One collapsible group in the item editor. The form used to be twelve flat
// blocks, so the file upload — the whole point of the screen — sat below
// eleven blocks of metadata. Grouping puts identity and content on the first
// screen and folds the rarely-filled parts away, with a count so a collapsed
// group never hides something the admin already entered.
const EditorGroup: React.FC<{
  n: number;
  title: string;
  badge?: number;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}> = ({ n, title, badge, open, onToggle, children }) => (
  <div className="rounded-[1.75rem] border border-slate-200 dark:border-white/[0.08] bg-slate-50/60 dark:bg-black/20 overflow-hidden">
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      className="w-full flex items-center gap-3 px-4 py-3.5 text-left hover:bg-white/70 dark:hover:bg-white/[0.04] transition-colors"
    >
      <span className="w-5 h-5 rounded-md bg-red-600 text-white text-[10px] font-black grid place-items-center shrink-0 tabular-nums">{n}</span>
      <span className="text-[10px] font-black uppercase tracking-[0.14em] text-slate-700 dark:text-slate-200 flex-1 min-w-0 truncate">{title}</span>
      {!open && !!badge && (
        <span className="text-[9px] font-black text-slate-500 dark:text-slate-400 bg-white dark:bg-white/10 border border-slate-200 dark:border-white/10 rounded-md px-1.5 py-0.5 shrink-0 tabular-nums">{badge}</span>
      )}
      <ChevronDown size={15} className={`text-slate-400 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
    </button>
    {open && <div className="px-4 pb-5 pt-1 space-y-6">{children}</div>}
  </div>
);

interface AdminProps {
  onBack: () => void;
  db: AppState;
  onUpdate: () => void;
  onLogout: () => void;
  /** Open an item's content (reader / video) to inspect it, without tracking. */
  onPreviewItem: (item: MediaItem) => void;
  isAdmin: boolean;
  setIsAdmin: (val: boolean) => void;
  lang: Locale;
  t: any;
}

const Admin: React.FC<AdminProps> = ({ onBack, db, onUpdate, onLogout, onPreviewItem, isAdmin, setIsAdmin, lang, t }) => {
  const ta = t.admin;
  const [apiKeyInput, setApiKeyInput] = useState('');
  // Removed 'users' from activeTab type as it is merged into security
  const [activeTab, setActiveTab] = useState<'stats' | 'items' | 'types' | 'data' | 'security' | 'scan'>('stats');
  const [editingItem, setEditingItem] = useState<Partial<MediaItem> | null>(null);
  // Publication date can be a full ISO date ("2021-05-29") or just a year
  // ("2021"). The mode is derived from the stored value whenever a different
  // item is opened, then toggled manually by the admin.
  const [pubDateMode, setPubDateMode] = useState<'date' | 'year'>('date');
  // Items-list controls on the admin "Add content" tab: text search across
  // localized title + author list, and a type chip filter. Both compose so
  // the admin can locate an item without scrolling a 300-row list.
  const [adminItemSearch, setAdminItemSearch] = useState('');
  const [adminItemTypeFilter, setAdminItemTypeFilter] = useState<string>('ALL');
  // Hosting filter: everything / only self-hosted / only externally-linked.
  // Admin-only on purpose — readers shouldn't have to care where a file sits.
  const [adminItemSourceFilter, setAdminItemSourceFilter] = useState<'ALL' | 'LOCAL' | 'EXTERNAL'>('ALL');
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

  // Refresh analytics every time the Stats tab is opened. The dep array on
  // the previous effect only includes isAdmin, so without this the timeline
  // and leaderboard would stay frozen on the snapshot from initial login —
  // even hours of traffic later they'd look unchanged.
  useEffect(() => {
    if (activeTab === 'stats' && isAdmin) {
      loadAnalytics().then(() => onUpdate());
    }
  }, [activeTab, isAdmin]); // eslint-disable-line react-hooks/exhaustive-deps

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
  // Items-list filter for the "Add content" tab. Search matches localized
  // title + every co-author, diacritics-insensitive. Default sort is newest-
  // added first so freshly imported items surface at the top.
  const adminFilteredItems = useMemo(() => {
    const norm = (s: string) => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    const q = norm(adminItemSearch.trim());
    let list = db.items.slice();
    if (adminItemTypeFilter !== 'ALL') list = list.filter(i => i.type === adminItemTypeFilter);
    // Hosting filter — admin-only. Lets the operator answer "what are we
    // actually serving ourselves?" (licence audits) vs "what do we merely
    // link to?". An item counts as external if any of its files is external.
    if (adminItemSourceFilter !== 'ALL') {
      const wantExternal = adminItemSourceFilter === 'EXTERNAL';
      list = list.filter(i => isExternallyHosted(i) === wantExternal);
    }
    if (q) {
      list = list.filter(i => {
        const title = norm(pickText(i.title, lang));
        const authors = norm((i.authors && i.authors.length ? i.authors.join(' ') : i.author) || '');
        return title.includes(q) || authors.includes(q);
      });
    }
    list.sort((a, b) => {
      const ta = a.addedDate ? new Date(a.addedDate).getTime() : 0;
      const tb = b.addedDate ? new Date(b.addedDate).getTime() : 0;
      return tb - ta;
    });
    return list;
  }, [db.items, adminItemSearch, adminItemTypeFilter, adminItemSourceFilter, lang]);

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

  // Which editor groups are expanded. Identity, content and description are
  // open by default because almost every item needs them; catalogue and rights
  // start folded — they are usually left empty and used to force a long scroll
  // past them to reach the file upload.
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({
    groupBasics: true, groupContent: true, groupDescription: true,
    groupCatalog: false, groupAccess: false,
  });
  const toggleGroup = (k: string) => setOpenGroups(p => ({ ...p, [k]: !p[k] }));

  // Shown on a collapsed group's header.
  const catalogFilled = editingItem ? [
    (editingItem.series || '').trim(),
    (editingItem.tags || []).length ? 'x' : '',
    (editingItem.articles || []).length ? 'x' : '',
  ].filter(Boolean).length : 0;
  const accessFilled = editingItem ? [
    editingItem.license?.code,
    editingItem.isPrivate ? 'x' : '',
    editingItem.allowDownload === false ? 'x' : '',
    editingItem.allowReading === false ? 'x' : '',
  ].filter(Boolean).length : 0;

  // Autofill from the DOI registry. Convenience, never a dependency: if the
  // resolver is unreachable the admin just types the fields in, and anything
  // already filled in is left alone — a lookup must not quietly overwrite a
  // title someone deliberately corrected. The year lands in the existing
  // publishedDate rather than a second year field.
  const [doiBusy, setDoiBusy] = useState(false);
  const handleDoiLookup = async () => {
    if (!editingItem) return;
    const doi = normalizeDoi(editingItem.publication?.doi || '');
    if (!doi) { toast.error(ta.doiInvalid); return; }
    setDoiBusy(true);
    try {
      const meta = await lookupDoi(doi);
      const next: Partial<MediaItem> = {
        ...editingItem,
        publication: {
          doi: meta.doi,
          type: meta.type || editingItem.publication?.type,
          journal: meta.journal || editingItem.publication?.journal,
          publisher: meta.publisher || editingItem.publication?.publisher,
        },
      };
      const titleEmpty = !(editingItem.title?.en || editingItem.title?.ru || editingItem.title?.es);
      if (meta.title && titleEmpty) {
        next.title = { ...(editingItem.title || { en: '', ru: '', es: '' }), en: meta.title };
      }
      if (meta.authors.length && !(editingItem.authors || []).length && !editingItem.author) {
        next.authors = meta.authors;
        next.author = meta.authors[0];
      }
      if (meta.year && !editingItem.publishedDate) next.publishedDate = meta.year;
      setEditingItem(next);
      toast.success(ta.doiFetched);
    } catch (e) {
      toast.error(`${ta.doiFailed}: ${(e as Error).message}`);
    } finally {
      setDoiBusy(false);
    }
  };

  const handleSaveItem = async () => {
    if (editingItem) {
      const hasTitle = editingItem.title && (editingItem.title.en || editingItem.title.ru || editingItem.title.es);
      if (!hasTitle) {
        toast.error(ta.titleRequired);
        return;
      }

      // Authors handling: `authors[]` is canonical, `author` is the
      // derived primary used by every legacy read site (search, card,
      // deep-link). Keep both in sync at save time so a downgrade still
      // finds the primary name on the flat field.
      const rawAuthors = (editingItem.authors && editingItem.authors.length)
        ? editingItem.authors
        : (editingItem.author ? [editingItem.author] : []);
      const cleanedAuthors = rawAuthors.map(a => (a || '').trim()).filter(Boolean);
      const primaryAuthor = cleanedAuthors[0] || 'Anonymous';
      const itemToSave = {
        ...editingItem,
        id: editingItem.id || Date.now().toString(),
        rating: editingItem.rating || 0,
        author: primaryAuthor,
        authors: cleanedAuthors.length ? cleanedAuthors : [primaryAuthor],
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
        allowReading: editingItem.allowReading !== undefined ? editingItem.allowReading : true,
        // Store the DOI in its canonical bare form whatever was pasted, so the
        // same work can't end up recorded two ways. An empty or unparseable
        // one drops the whole block rather than persisting `{doi: ''}`.
        publication: (() => {
          const doi = normalizeDoi(editingItem.publication?.doi || '');
          if (!doi) return undefined;
          const p = editingItem.publication!;
          return {
            doi,
            ...(p.type ? { type: p.type } : {}),
            ...(p.journal?.trim() ? { journal: p.journal.trim() } : {}),
            ...(p.publisher?.trim() ? { publisher: p.publisher.trim() } : {}),
          };
        })(),
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

  // Typing a URL into a file block also pre-answers "is this someone else's?".
  // Only a suggestion — the admin can flip the toggle afterwards, and we never
  // re-guess once they have, so an explicit choice is never overwritten.
  const handleUpdateFormatUrl = (id: string, url: string) => {
    if (!editingItem?.formats) return;
    const updated = editingItem.formats.map(f =>
      f.id === id
        ? { ...f, url, external: f.external === undefined ? isExternalUrl(url) : f.external }
        : f,
    );
    setEditingItem({ ...editingItem, formats: updated });
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

  // Tag chip input. Earlier this was a single text field whose value was
  // `tags.join(', ')`, but every keystroke ran `split(',').map(trim).filter`,
  // which silently ate trailing commas/spaces — so the user couldn't type a
  // separator at all. Now the typing buffer lives in its own state and only
  // commits to the tag array when the user presses comma / space / Enter
  // (or blurs), giving the standard chip-input UX.
  const [tagInput, setTagInput] = useState('');

  const commitTagBuffer = (raw: string) => {
    if (!editingItem) return;
    const parts = raw.split(/[,;\n]+/).map(p => p.trim()).filter(Boolean);
    if (parts.length === 0) return;
    const current = editingItem.tags || [];
    // Case-insensitive dedup while preserving the original casing of whichever
    // copy the user typed first.
    const seen = new Set(current.map(t => t.toLowerCase()));
    const merged = [...current];
    for (const p of parts) {
      const k = p.toLowerCase();
      if (!seen.has(k)) { merged.push(p); seen.add(k); }
    }
    setEditingItem({ ...editingItem, tags: merged });
  };

  const handleTagInputChange = (raw: string) => {
    // If the user just typed a separator, commit everything to the left of it
    // and keep whatever's to the right as the new buffer (lets them paste a
    // comma-separated list and get individual chips).
    if (/[,;\n]/.test(raw)) {
      const parts = raw.split(/[,;\n]/);
      const last = parts.pop() || '';
      commitTagBuffer(parts.join(','));
      setTagInput(last);
    } else {
      setTagInput(raw);
    }
  };

  const handleTagInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!editingItem) return;
    if (e.key === 'Enter' || (e.key === ' ' && tagInput.trim().length > 0)) {
      e.preventDefault();
      commitTagBuffer(tagInput);
      setTagInput('');
    } else if (e.key === 'Backspace' && tagInput === '' && (editingItem.tags || []).length > 0) {
      // Empty-buffer backspace removes the last chip — standard chip-input UX.
      const tags = [...(editingItem.tags || [])];
      tags.pop();
      setEditingItem({ ...editingItem, tags });
    }
  };

  const removeTag = (tag: string) => {
    if (!editingItem) return;
    setEditingItem({ ...editingItem, tags: (editingItem.tags || []).filter(t => t !== tag) });
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

  // #36 GDPR right-to-erasure. Wipes everything a single user has stored on
  // the server (favourites, ratings, bookmarks, annotations,
  // reading progress) and un-attributes their analytics rows. Used to honour
  // written deletion requests under GDPR Art. 17 / 152-ФЗ.
  const [eraseTarget, setEraseTarget] = useState('');
  const handleEraseUser = async () => {
    const target = eraseTarget.trim();
    if (!target) return;
    if (!confirm(`${ta.eraseUserConfirm} «${target}»?\n${ta.eraseUserConfirmDesc}`)) return;
    try {
      await eraseUserData(target);
      toast.success(ta.eraseUserDone);
      setEraseTarget('');
      onUpdate();
    } catch { /* toasted by db layer */ }
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

  // What can we key an exclude on for this log row? A Telegram numeric id or an
  // @handle identifies one person exactly. The logged IP can't be used: it is
  // stored anonymised, so excluding it would silently cover the visitor's whole
  // subnet. Anonymous rows therefore get no button.
  const visitorExcludeKey = (username?: string): { kind: 'id' | 'name'; value: string } | null => {
    const u = (username || '').trim();
    if (!u || u.toLowerCase() === 'guest') return null;
    if (u.startsWith('id_')) {
      const id = u.slice(3);
      return id ? { kind: 'id', value: id } : null;
    }
    return { kind: 'name', value: u.toLowerCase().replace(/^@/, '') };
  };

  // A pseudonym is opaque, so give it a stable colour and show only its first
  // chars: the eye matches "same swatch = same person" far faster than it
  // compares hex strings down a column.
  const visitorTint = (h: string) => `hsl(${parseInt(h.slice(0, 4), 16) % 360} 62% 48%)`;

  // Exclude one exact visitor by pseudonym. Works for anonymous rows, where
  // there is no @handle or Telegram id to key on and the stored IP covers a
  // whole subnet.
  const handleExcludeVisitorHash = async (hash: string) => {
    try {
      await addAnalyticsExcludeVisitor(hash);
      toast.success(ta.excludeThisVisitorDone);
    } catch { /* toasted by db layer */ }
    onUpdate();
  };

  const handleRemoveExcludeVisitor = async (hash: string) => {
    try { await removeAnalyticsExcludeVisitor(hash); } catch { /* toasted */ }
    onUpdate();
  };

  // Exclude exactly the visitor on this log row, by identity.
  const handleExcludeVisitor = async (key: { kind: 'id' | 'name'; value: string }) => {
    try {
      if (key.kind === 'id') await addAnalyticsExcludeUserId(key.value);
      else await addAnalyticsExcludeUsername(key.value);
      toast.success(ta.excludeThisVisitorDone);
    } catch { /* toasted by db layer */ }
    onUpdate();
  };

  // Apply the exclude list to rows that predate it. The write-time filter only
  // stops new entries, so without this an exclusion added today leaves every
  // earlier visit sitting in the access log.
  const [purging, setPurging] = useState(false);
  const handlePurgeExcluded = async () => {
    if (!confirm(ta.purgeExcludedConfirm)) return;
    setPurging(true);
    try {
      const { deleted, ipsSkipped, browserTokensSkipped } = await purgeExcludedVisits();
      await loadAnalytics();
      toast.success(`${ta.purgeExcludedDone}: ${deleted}`);
      // Say what the purge could NOT reach rather than letting the admin assume
      // it covered every kind of exclude on the list.
      if (ipsSkipped > 0) toast.info(ta.purgeExcludedIpNote);
      if (browserTokensSkipped > 0) toast.info(ta.purgeExcludedBrowserNote);
    } catch {
      toast.error(ta.purgeExcludedFailed);
    } finally {
      setPurging(false);
      onUpdate();
    }
  };

  // ── Content scan (what can actually be indexed) ──────────────────────────
  const [scanReport, setScanReport] = useState<ContentScanReport | null>(null);
  const [scanFilter, setScanFilter] = useState<'all' | ContentScanState>('all');
  // Kept in a ref, not state: the polling interval closes over its own copy of
  // state and would keep asking forever after a pass has finished.
  const scanRunningRef = useRef(false);

  useEffect(() => {
    if (activeTab !== 'scan' || !isAdmin) return;
    let cancelled = false;
    const tick = async () => {
      const report = await loadContentScan();
      if (cancelled) return;
      scanRunningRef.current = report.job.running;
      setScanReport(report);
    };
    tick();
    // Poll only while a pass is in flight — an idle tab has no reason to talk
    // to the server every two seconds.
    const id = setInterval(() => { if (scanRunningRef.current) tick(); }, 2000);
    return () => { cancelled = true; clearInterval(id); };
  }, [activeTab, isAdmin]);

  const refreshScan = async () => {
    const report = await loadContentScan();
    scanRunningRef.current = report.job.running;
    setScanReport(report);
  };

  const handleScanRun = async () => {
    try {
      await startContentScan();
      // Start polling immediately: the first pass over a large library takes a
      // while to report anything, and a dead-looking button invites a second click.
      scanRunningRef.current = true;
      await refreshScan();
    } catch { /* writeRequest already raised a toast */ }
  };

  const handleScanStop = async () => {
    try {
      await stopContentScan();
      await refreshScan();
    } catch { /* writeRequest already raised a toast */ }
  };

  // Four questions the numbers have to answer: what can be indexed today, what
  // needs OCR money spent on it, what is simply broken, and what belongs to a
  // later step. Every verdict lands in exactly one of them.
  const scanCounts = useMemo(() => {
    const by: Record<string, number> = {};
    let pages = 0, chars = 0;
    for (const s of scanReport?.summary || []) {
      by[s.state] = s.files;
      pages += s.pages;
      chars += s.chars;
    }
    const sum = (...states: string[]) => states.reduce((n, k) => n + (by[k] || 0), 0);
    return {
      by, pages, chars,
      ready: sum('text'),
      ocr: sum('scan', 'partial'),
      attention: sum('missing', 'error', 'unsupported', 'nothing'),
      later: sum('media', 'external'),
      total: Object.values(by).reduce((a, b) => a + b, 0),
    };
  }, [scanReport]);

  const scanRows = useMemo(() => {
    const rows = scanReport?.rows || [];
    return scanFilter === 'all' ? rows : rows.filter(r => r.state === scanFilter);
  }, [scanReport, scanFilter]);

  // ── Index (extracted text and search chunks) ─────────────────────────────
  const [openCheck, setOpenCheck] = useState(false);
  const [openIndex, setOpenIndex] = useState(true);
  const [openQueue, setOpenQueue] = useState(false);
  const [openMetric, setOpenMetric] = useState(false);
  const [searchStats, setSearchStats] = useState<SearchStats | null>(null);
  const queueWasActive = useRef(false);
  const [jobs, setJobs] = useState<JobRow[]>([]);
  const [jobTotals, setJobTotals] = useState<JobTotals>({ queued: 0, running: 0, done: 0, failed: 0, cancelled: 0 });
  const jobsActiveRef = useRef(false);
  const [indexReport, setIndexReport] = useState<IndexReport | null>(null);
  const indexRunningRef = useRef(false);
  const [pagesFor, setPagesFor] = useState<IndexRow | null>(null);
  const [pageRows, setPageRows] = useState<IndexPage[]>([]);
  const [pageTotal, setPageTotal] = useState(0);
  const [editingPage, setEditingPage] = useState<number | null>(null);
  const [pageDraft, setPageDraft] = useState('');
  const [pagesBusy, setPagesBusy] = useState(false);

  useEffect(() => {
    // Loaded for the content list as well: every material card shows whether it
    // is in the index, and that has to be true the moment the list opens.
    if ((activeTab !== 'scan' && activeTab !== 'items') || !isAdmin) return;
    let cancelled = false;
    const tick = async () => {
      const report = await loadIndexReport();
      if (cancelled) return;
      indexRunningRef.current = report.job.running;
      setIndexReport(report);
    };
    tick();
    const id = setInterval(() => { if (indexRunningRef.current) tick(); }, 2000);
    return () => { cancelled = true; clearInterval(id); };
  }, [activeTab, isAdmin]);

  useEffect(() => {
    // Also on the content list: its cards open the editor, and the editor shows
    // the progress of work started from inside it.
    if ((activeTab !== 'scan' && activeTab !== 'items') || !isAdmin) return;
    let cancelled = false;
    const tick = async () => {
      const { jobs: rows, totals } = await loadJobs();
      if (cancelled) return;
      // Poll only while something is actually moving.
      const active = totals.queued + totals.running > 0;
      // The moment the queue empties, whatever it produced is not on screen yet.
      if (jobsActiveRef.current && !active) refreshIndex();
      jobsActiveRef.current = active;
      setJobs(rows);
      setJobTotals(totals);
    };
    tick();
    const id = setInterval(() => { if (jobsActiveRef.current) tick(); }, 2000);
    return () => { cancelled = true; clearInterval(id); };
  }, [activeTab, isAdmin]);

  useEffect(() => {
    if (activeTab !== 'scan' || !isAdmin) return;
    loadSearchStats().then(setSearchStats);
  }, [activeTab, isAdmin]);

  const refreshJobs = async () => {
    const { jobs: rows, totals } = await loadJobs();
    jobsActiveRef.current = totals.queued + totals.running > 0;
    setJobs(rows);
    setJobTotals(totals);
  };

  const handleQueueSubtitles = async (itemId?: string) => {
    try {
      const { queued, skipped } = await queueSubtitles(itemId);
      jobsActiveRef.current = true;
      await refreshJobs();
      const s = ta.scan;
      toast.success(skipped.length
        ? `${s.queueQueuedN}: ${queued}. ${s.queueSkipped}: ${skipped.length}`
        : `${s.queueQueuedN}: ${queued}`);
      if (skipped.length) skipped.forEach((line: string) => toast.error(line));
    } catch { /* writeRequest already raised a toast */ }
  };

  const subtitleInputRef = useRef<HTMLInputElement | null>(null);
  const [subtitleBusy, setSubtitleBusy] = useState(false);

  /**
   * Upload a subtitle file and put it to work in one gesture.
   *
   * The queue button only ever processed files that were already uploaded, so
   * "Импортировать субтитры" opened nothing and, with no such file anywhere,
   * silently queued zero. Uploading, cataloguing and queueing are one intention;
   * splitting them across two screens was the mistake.
   *
   * The item is saved before the job is queued: the planner reads the catalogue
   * from the database, and a file that exists only in this form is invisible to it.
   */
  const uploadSubtitleFile = (file: File) => {
    if (!editingItem?.id) return;
    const itemId = editingItem.id;
    const format: FileFormat = {
      id: Date.now().toString(),
      name: ta.scan.targetSubtitles,
      url: '',
      size: '0MB',
      language: (editingItem.contentLanguages?.[0] as any) || 'ru',
      allowDownload: false,
      allowReading: false,
    };
    const formData = new FormData();
    formData.append('lang', format.language || 'ru');
    formData.append('file', file);
    const xhr = new XMLHttpRequest();
    setSubtitleBusy(true);
    xhr.onload = async () => {
      if (subtitleInputRef.current) subtitleInputRef.current.value = '';
      if (xhr.status !== 200) {
        setSubtitleBusy(false);
        toast.error(ta.fileUploadError + xhr.status);
        return;
      }
      try {
        const res = JSON.parse(xhr.responseText);
        const next = {
          ...editingItem,
          formats: [...(editingItem.formats || []), { ...format, url: res.url, size: res.size }],
        } as MediaItem;
        setEditingItem(next);
        await updateItem(next);
        const { queued, skipped } = await queueSubtitles(itemId);
        await refreshJobs();
        await refreshIndex();
        onUpdate();
        toast.success(`${ta.scan.queueQueuedN}: ${queued}`);
        skipped.forEach((line: string) => toast.error(line));
      } catch (e: any) {
        toast.error(e?.message || String(e));
      } finally {
        setSubtitleBusy(false);
      }
    };
    xhr.onerror = () => { setSubtitleBusy(false); toast.error(ta.fileUploadError); };
    xhr.open('POST', `/api/upload/${itemId}/file`);
    const key = getServerApiKey();
    if (key) xhr.setRequestHeader('x-api-key', key);
    xhr.send(formData);
  };

  const handleTranscribe = async (method: TranscribeMethod, scope?: { itemId?: string; targetUrl?: string }) => {
    try {
      const { queued } = await queueTranscribe(method, scope);
      jobsActiveRef.current = true;
      // Unfold the queue: a task nobody can watch is a task nobody trusts.
      if (queued > 0) setOpenQueue(true);
      await refreshJobs();
      toast.success(`${ta.scan.queuedN}: ${queued}`);
    } catch { /* writeRequest already raised a toast */ }
  };

  const handleClearHistory = async (itemId?: string) => {
    try { await clearJobHistory(itemId); await refreshJobs(); }
    catch { /* writeRequest already raised a toast */ }
  };

  const handleUnindex = async (itemId: string) => {
    if (!confirm(ta.scan.unindexConfirm)) return;
    try {
      await unindexItem(itemId);
      await refreshIndex();
      toast.success(ta.scan.unindexDone);
    } catch { /* writeRequest already raised a toast */ }
  };

  const handleJobAction = async (id: number, action: 'cancel' | 'retry') => {
    try { await jobAction(id, action); jobsActiveRef.current = true; await refreshJobs(); }
    catch { /* writeRequest already raised a toast */ }
  };

  const refreshIndex = async () => {
    const report = await loadIndexReport();
    indexRunningRef.current = report.job.running;
    setIndexReport(report);
  };

  const handleIndexRun = async (itemId?: string) => {
    try {
      await startIndexing(itemId);
      indexRunningRef.current = true;
      await refreshIndex();
    } catch { /* writeRequest already raised a toast */ }
  };

  const handleIndexStop = async () => {
    try { await stopIndexing(); await refreshIndex(); }
    catch { /* writeRequest already raised a toast */ }
  };

  const openPages = async (row: IndexRow) => {
    setPagesFor(row);
    setEditingPage(null);
    setPageRows([]);
    setPageTotal(0);
    const { total, pages } = await loadIndexPages(row.item_id, row.format_url, 0, 50);
    setPageTotal(total);
    setPageRows(pages);
  };

  const loadMorePages = async () => {
    if (!pagesFor) return;
    const { pages } = await loadIndexPages(pagesFor.item_id, pagesFor.format_url, pageRows.length, 50);
    setPageRows(prev => [...prev, ...pages]);
  };

  const handleSavePage = async (page: number) => {
    if (!pagesFor) return;
    setPagesBusy(true);
    try {
      await savePageText(pagesFor.item_id, pagesFor.format_url, page, pageDraft);
      // Re-read rather than patch locally: the server recomputes the character
      // count, the quality and the chunk total, and a guess here would drift.
      const { total, pages } = await loadIndexPages(pagesFor.item_id, pagesFor.format_url, 0, Math.max(pageRows.length, 50));
      setPageTotal(total);
      setPageRows(pages);
      setEditingPage(null);
      await refreshIndex();
      toast.success(ta.scan.pagesSaved);
    } catch { /* writeRequest already raised a toast */ }
    finally { setPagesBusy(false); }
  };

  const indexByItem = useMemo(() => {
    const byItem = new Map<string, IndexRow[]>();
    for (const row of indexReport?.rows || []) {
      const list = byItem.get(row.item_id);
      if (list) list.push(row); else byItem.set(row.item_id, [row]);
    }
    return byItem;
  }, [indexReport]);

  /**
   * What the content list shows on one material, and which actions it offers.
   *
   * The denominator comes from the item, not from the report: a target that has
   * never been indexed has no row at all, and counting only rows would report
   * "1 of 1" on a material where half of it was never touched.
   *
   * "Indexable" has to mean exactly what the server will attempt, or the card
   * hides a button for work that would in fact have run. That includes files
   * flagged external and a material catalogued as a bare source link — both are
   * fetched, read and thrown away — and excludes subtitle files, which are not
   * documents but transcripts of something else.
   */
  const isSubtitleUrl = (url: string) => /\.(srt|vtt)$/i.test(url.split(/[?#]/)[0]);

  const itemIndexState = (item: MediaItem) => {
    const formats = (item.formats || []).filter(f => typeof f.url === 'string' && f.url.trim());
    const docs = formats.filter(f => !isSubtitleUrl(f.url));
    const subtitleFiles = formats.filter(f => isSubtitleUrl(f.url));
    // A source link stands in for the material only when nothing else does.
    const sourceUrl = !formats.length ? (item.source?.url || '').trim() : '';
    const videos = (item.videos || []).filter(v => typeof v?.url === 'string' && v.url.trim());
    const mediaFiles = docs.filter(f => /\.(mp4|webm|mkv|mp3|m4a|m4b|ogg|oga|opus|wav)$/i.test(f.url.split(/[?#]/)[0]));

    const documents = docs.length - mediaFiles.length + (sourceUrl ? 1 : 0);
    const spoken = videos.length + mediaFiles.length;
    const total = documents + spoken;

    const rows = indexByItem.get(item.id) || [];
    const indexed = rows.filter(r => r.state === 'indexed');
    const failed = rows.filter(r => r.state === 'failed');

    // Subtitles attach to exactly one obvious target, same rule as the server.
    const canImportSubtitles = subtitleFiles.length > 0 && spoken === 1;
    const canIndexDocuments = documents > 0;

    const base = {
      total, documents, spoken, done: indexed.length,
      canIndexDocuments, canImportSubtitles,
      hasSubtitleFile: subtitleFiles.length > 0,
    };

    if (!total) return { ...base, kind: 'none' as const };
    if (failed.length) return { ...base, kind: 'failed' as const, detail: failed[0].detail };
    if (indexed.length >= total) {
      return {
        ...base, kind: 'ok' as const,
        chunks: indexed.reduce((n, r) => n + (r.chunk_count || 0), 0),
        manual: indexed.reduce((n, r) => n + (r.manual_pages || 0), 0),
        quality: Math.min(...indexed.map(r => r.quality ?? 1)),
      };
    }
    // Nothing indexed, nothing to press: a video with no transcript and no
    // subtitle file. Say what is missing instead of "nothing to index".
    if (!indexed.length && !canIndexDocuments && !canImportSubtitles) {
      return { ...base, kind: 'needsSubtitles' as const };
    }
    return { ...base, kind: indexed.length ? ('partial' as const) : ('missing' as const) };
  };

  // Green above clean-typeset level, amber where formulas or conversion damage
  // start showing, red where the text is mostly not letters.
  const qualityTone = (q: number | null) =>
    q === null ? 'text-slate-400'
    : q >= 0.85 ? 'text-emerald-600'
    : q >= 0.6  ? 'text-amber-600'
    : 'text-red-600';

  const renderIndexPanel = (s: any, num: (n: number) => string) => {
    const job = indexReport?.job;
    const totals = indexReport?.totals;
    const rows = indexReport?.rows || [];
    const pct = job?.total ? Math.round((job.done / job.total) * 100) : 0;
    const lastRun = job?.finishedAt || (rows.length ? rows[0].indexed_at : null);

    return (
      <Panel
        icon={<Database size={18} strokeWidth={2.5} />}
        title={s.sectionIndex}
        subtitle={s.sectionIndexSub}
        badge={totals ? `${num(totals.indexed)} ${s.indexedOf} ${num(totals.indexable)}` : undefined}
        open={openIndex}
        onToggle={() => setOpenIndex(v => !v)}
      >
        <p className="text-[10px] md:text-xs text-slate-500 dark:text-slate-400 font-bold leading-relaxed max-w-3xl mb-6">{s.indexIntro}</p>

        <div className="flex flex-wrap items-center gap-3 mb-4">
          {job?.running ? (
            <button
              onClick={handleIndexStop}
              className="flex items-center gap-2 px-5 py-3 bg-slate-800 dark:bg-white/10 text-white rounded-2xl text-[10px] font-black uppercase tracking-widest shadow-md active:scale-95 transition-all"
            >
              <Square size={13} strokeWidth={3} /> {s.stop}
            </button>
          ) : (
            <button
              onClick={() => handleIndexRun()}
              className="flex items-center gap-2 px-5 py-3 bg-red-600 hover:bg-red-700 text-white rounded-2xl text-[10px] font-black uppercase tracking-widest shadow-md active:scale-95 transition-all"
            >
              <Play size={13} strokeWidth={3} /> {rows.length ? s.indexRerun : s.indexRun}
            </button>
          )}
          <p className="text-[9px] font-black uppercase tracking-widest text-slate-400 dark:text-slate-500">
            {job?.running
              ? `${s.running} · ${num(job.done)} ${s.progress} ${num(job.total)}`
              : lastRun
                ? `${s.indexLastRun}: ${new Date(lastRun).toLocaleString(lang === 'ru' ? 'ru-RU' : lang)}`
                : s.indexNever}
          </p>
        </div>

        {job?.running && (
          <>
            <div className="h-1.5 w-full bg-slate-100 dark:bg-white/10 rounded-full overflow-hidden mb-2">
              <div className="h-full bg-red-600 rounded-full transition-all duration-500" style={{ width: `${pct}%` }} />
            </div>
            {job.current && <p className="text-[9px] text-slate-400 dark:text-slate-500 font-bold truncate mb-4">{job.current}</p>}
          </>
        )}

        {job?.error && (
          <p className="text-[10px] font-bold text-red-600 bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/25 rounded-2xl px-4 py-3 mb-4 break-words">
            {job.error}
          </p>
        )}

        {totals && (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            {[
              { k: 'ok',    v: `${num(totals.indexed)} / ${num(totals.indexable)}`, t: s.indexed,      tone: 'text-emerald-600' },
              { k: 'fail',  v: num(totals.failed),   t: s.indexFailed,  tone: totals.failed ? 'text-red-600' : 'text-slate-400' },
              { k: 'skip',  v: num(totals.skipped),  t: s.indexSkipped, tone: 'text-slate-400' },
              { k: 'chunk', v: num(totals.chunks),   t: s.indexChunks,  tone: 'text-slate-700 dark:text-slate-200' },
            ].map(c => (
              <div key={c.k} className="p-4 rounded-3xl bg-slate-50 dark:bg-black/40 border border-slate-100 dark:border-white/[0.08]">
                <p className={`text-2xl md:text-[26px] font-black tracking-tighter tabular-nums ${c.tone}`}>{c.v}</p>
                <p className="text-[9px] font-black uppercase tracking-widest text-slate-700 dark:text-slate-300 mt-1">{c.t}</p>
              </div>
            ))}
          </div>
        )}

        {totals && totals.manual_pages > 0 && (
          <p className="text-[9px] font-black uppercase tracking-widest text-slate-400 dark:text-slate-500 mt-4">
            {num(totals.pages)} {s.pages} · {num(totals.chars)} {s.chars} · {num(totals.manual_pages)} {s.indexManual}
          </p>
        )}
        {totals && totals.manual_pages === 0 && totals.pages > 0 && (
          <p className="text-[9px] font-black uppercase tracking-widest text-slate-400 dark:text-slate-500 mt-4">
            {num(totals.pages)} {s.pages} · {num(totals.chars)} {s.chars}
          </p>
        )}

        {/* What is left to do, not what kind of thing it is. The line used to
            count every video and call it "outside indexing", which stayed on
            screen after the video had been transcribed and indexed — telling
            the admin that finished work still needed doing. It now counts only
            targets with no transcript yet, and disappears when there are none. */}
        {totals && totals.spoken_pending > 0 ? (
          <p className="text-[9px] font-black uppercase tracking-widest text-slate-400 dark:text-slate-500 mt-2">
            {s.indexNoTranscript}: {num(totals.spoken_pending)} {s.stateMedia} — {s.indexNoTranscriptWhy}
          </p>
        ) : null}

        <div className="h-px bg-slate-100 dark:bg-white/[0.08] my-6" />

        {rows.length === 0 ? (
          <p className="text-[10px] font-bold text-slate-400 dark:text-slate-500 py-6 text-center">{s.indexEmpty}</p>
        ) : (
          <div className="space-y-2">
            {rows.map(r => (
              <div
                key={`${r.item_id}::${r.format_url}`}
                className="p-3 rounded-2xl bg-slate-50 dark:bg-black/40 border border-slate-100 dark:border-white/[0.08]"
              >
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                  <span className={`shrink-0 w-[6.5rem] truncate text-center px-2 py-1 rounded-lg border text-[8px] font-black uppercase tracking-widest
                    ${r.state === 'indexed'
                      ? 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-400 dark:border-emerald-500/25'
                      : r.state === 'failed'
                        ? 'bg-red-50 text-red-700 border-red-200 dark:bg-red-500/10 dark:text-red-400 dark:border-red-500/25'
                        : 'bg-slate-100 text-slate-500 border-slate-200 dark:bg-white/5 dark:text-slate-400 dark:border-white/10'}`}>
                    {r.state === 'indexed' ? s.indexStateIndexed : r.state === 'failed' ? s.indexStateFailed : s.indexStateSkipped}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-[11px] font-black text-slate-800 dark:text-slate-100 truncate">
                      {pickText(r.title || undefined, lang, r.item_id)}
                    </p>
                    <p className="text-[9px] font-bold text-slate-400 dark:text-slate-500 truncate">
                      {r.filename || r.format_url}
                      {r.method ? ` · ${r.method}` : ''}
                    </p>
                  </div>
                  {r.state === 'indexed' && (
                    <p className="text-[9px] font-black uppercase tracking-widest text-slate-400 dark:text-slate-500 tabular-nums whitespace-nowrap">
                      {num(r.pages || 0)} {s.pages} · {num(r.chars || 0)} {s.chars} · {num(r.chunk_count || 0)} {s.indexChunks}
                      {r.quality !== null && (
                        <span className={`ml-2 ${qualityTone(r.quality)}`}>{s.indexQuality} {r.quality.toFixed(2)}</span>
                      )}
                      {r.manual_pages > 0 && (
                        <span className="ml-2 text-red-600">· {num(r.manual_pages)} {s.indexManual}</span>
                      )}
                    </p>
                  )}
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      onClick={() => handleIndexRun(r.item_id)}
                      disabled={job?.running}
                      title={s.indexOne}
                      className="px-3 py-2 rounded-xl bg-white dark:bg-white/[0.06] border border-slate-200 dark:border-white/10 text-[9px] font-black uppercase tracking-widest text-slate-500 dark:text-slate-300 hover:border-red-300 hover:text-red-600 disabled:opacity-40 transition-colors"
                    >
                      <RefreshCw size={12} strokeWidth={3} />
                    </button>
                    {r.state === 'indexed' && (
                      <button
                        onClick={() => openPages(r)}
                        className="px-3 py-2 rounded-xl bg-white dark:bg-white/[0.06] border border-slate-200 dark:border-white/10 text-[9px] font-black uppercase tracking-widest text-slate-500 dark:text-slate-300 hover:border-red-300 hover:text-red-600 transition-colors"
                      >
                        {s.indexPages}
                      </button>
                    )}
                  </div>
                </div>
                {r.detail && (
                  <p className="text-[9px] font-bold text-slate-400 dark:text-slate-500 leading-snug mt-2 break-words">{r.detail}</p>
                )}
              </div>
            ))}
          </div>
        )}

        <p className="text-[9px] text-slate-400 dark:text-slate-500 font-bold leading-relaxed mt-4 max-w-3xl">{s.indexQualityHint}</p>
      </Panel>
    );
  };

  const renderMetricPanel = (s: any, num: (n: number) => string) => {
    const st = searchStats;
    const t0 = st?.totals || { queries: 0, with_results: 0, opened: 0 };
    // The share that reached a book. Everything else here is context for it.
    const rate = t0.queries ? Math.round((t0.opened / t0.queries) * 100) : 0;

    return (
      <Panel
        icon={<SearchIcon size={18} strokeWidth={2.5} />}
        title={s.metricTitle}
        subtitle={s.metricSub}
        badge={t0.queries ? `${num(rate)}%` : undefined}
        open={openMetric}
        onToggle={() => setOpenMetric(v => !v)}
      >
        <p className="text-[10px] md:text-xs text-slate-500 dark:text-slate-400 font-bold leading-relaxed max-w-3xl mb-5">{s.metricIntro}</p>

        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {[
            { v: num(t0.queries),      t: s.metricQueries, tone: 'text-slate-700 dark:text-slate-200' },
            { v: num(t0.with_results), t: s.metricFound,   tone: 'text-slate-700 dark:text-slate-200' },
            { v: num(t0.opened),       t: s.metricOpened,  tone: 'text-emerald-600' },
            { v: `${num(rate)}%`,      t: s.metricRate,    tone: rate >= 25 ? 'text-emerald-600' : 'text-amber-600' },
          ].map((c, i) => (
            <div key={i} className="p-4 rounded-3xl bg-slate-50 dark:bg-black/40 border border-slate-100 dark:border-white/[0.08]">
              <p className={`text-2xl md:text-[26px] font-black tracking-tighter tabular-nums ${c.tone}`}>{c.v}</p>
              <p className="text-[9px] font-black uppercase tracking-widest text-slate-700 dark:text-slate-300 mt-1">{c.t}</p>
            </div>
          ))}
        </div>
        <p className="text-[9px] font-black uppercase tracking-widest text-slate-400 dark:text-slate-500 mt-3">{s.metricDays}</p>

        {!t0.queries && (
          <p className="text-[10px] font-bold text-slate-400 dark:text-slate-500 py-6 text-center">{s.metricEmpty}</p>
        )}

        {!!st?.misses.length && (
          <>
            <div className="h-px bg-slate-100 dark:bg-white/[0.08] my-6" />
            <p className="text-[10px] font-black uppercase tracking-widest text-slate-700 dark:text-slate-300">{s.metricMisses}</p>
            <p className="text-[9px] font-bold text-slate-400 dark:text-slate-500 leading-relaxed mt-1 mb-3 max-w-3xl">{s.metricMissesHint}</p>
            <div className="flex flex-wrap gap-2">
              {st.misses.slice(0, 24).map(m => (
                <span key={m.query} className="px-3 py-1.5 rounded-xl bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/25 text-[10px] font-bold text-amber-700 dark:text-amber-400">
                  {m.query}{m.n > 1 && <span className="ml-1.5 tabular-nums opacity-70">×{m.n}</span>}
                </span>
              ))}
            </div>
          </>
        )}

        {!!st?.recent.length && (
          <>
            <div className="h-px bg-slate-100 dark:bg-white/[0.08] my-6" />
            <p className="text-[10px] font-black uppercase tracking-widest text-slate-700 dark:text-slate-300 mb-3">{s.metricRecent}</p>
            <div className="space-y-1.5">
              {st.recent.slice(0, 20).map((r, i) => (
                <div key={i} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 rounded-xl bg-slate-50 dark:bg-black/40 border border-slate-100 dark:border-white/[0.08]">
                  <span className="text-[11px] font-bold text-slate-800 dark:text-slate-100 truncate min-w-0 flex-1">{r.query}</span>
                  <span className={`text-[9px] font-black uppercase tracking-widest tabular-nums ${r.results ? 'text-slate-400 dark:text-slate-500' : 'text-amber-600'}`}>
                    {num(r.results)}
                  </span>
                  {r.opened_item && (
                    <span className="text-[9px] font-black uppercase tracking-widest text-emerald-600 truncate">
                      → {r.opened_pos || r.opened_item}
                    </span>
                  )}
                </div>
              ))}
            </div>
          </>
        )}
      </Panel>
    );
  };

  const renderQueuePanel = (s: any, num: (n: number) => string) => {
    const active = jobTotals.queued + jobTotals.running;
    const badge = active
      ? `${num(active)} ${s.queueRunning}`
      : jobTotals.failed ? `${num(jobTotals.failed)} ${s.queueFailed}` : undefined;
    const stateStyles: Record<string, string> = {
      running:   'bg-red-50 text-red-700 border-red-200 dark:bg-red-500/10 dark:text-red-400 dark:border-red-500/25',
      queued:    'bg-slate-100 text-slate-500 border-slate-200 dark:bg-white/5 dark:text-slate-400 dark:border-white/10',
      done:      'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-400 dark:border-emerald-500/25',
      failed:    'bg-red-50 text-red-700 border-red-200 dark:bg-red-500/10 dark:text-red-400 dark:border-red-500/25',
      cancelled: 'bg-slate-100 text-slate-400 border-slate-200 dark:bg-white/5 dark:text-slate-500 dark:border-white/10',
    };
    const stateLabel: Record<string, string> = {
      running: s.queueRunning, queued: s.queueQueued, done: s.queueDone,
      failed: s.queueFailed, cancelled: s.queueCancelled,
    };

    return (
      <Panel
        icon={<RefreshCw size={18} strokeWidth={2.5} />}
        title={s.queueTitle}
        subtitle={s.queueSub}
        badge={badge}
        open={openQueue}
        onToggle={() => setOpenQueue(v => !v)}
      >
        <p className="text-[10px] md:text-xs text-slate-500 dark:text-slate-400 font-bold leading-relaxed max-w-3xl mb-6">{s.queueIntro}</p>

        <div className="flex flex-wrap items-center gap-3 mb-5">
          <button
            onClick={handleQueueSubtitles}
            className="flex items-center gap-2 px-5 py-3 bg-red-600 hover:bg-red-700 text-white rounded-2xl text-[10px] font-black uppercase tracking-widest shadow-md active:scale-95 transition-all"
          >
            <Play size={13} strokeWidth={3} /> {s.queueSubtitles}
          </button>
          <button
            onClick={() => handleTranscribe('platform-subs')}
            title={s.subsFromPlatformHint}
            className="flex items-center gap-2 px-5 py-3 bg-white dark:bg-white/[0.06] border border-slate-300 dark:border-white/15 rounded-2xl text-[10px] font-black uppercase tracking-widest text-slate-600 dark:text-slate-300 hover:border-red-400 hover:text-red-600 active:scale-95 transition-all"
          >
            <Video size={13} strokeWidth={3} /> {s.subsFromPlatform}
          </button>
          <button
            onClick={() => handleClearHistory()}
            className="flex items-center gap-2 px-5 py-3 bg-white dark:bg-white/[0.06] border border-slate-300 dark:border-white/15 rounded-2xl text-[10px] font-black uppercase tracking-widest text-slate-500 dark:text-slate-400 hover:border-red-400 hover:text-red-600 active:scale-95 transition-all"
          >
            <Trash2 size={13} strokeWidth={3} /> {s.clearHistory}
          </button>
          <button
            onClick={() => handleTranscribe('asr')}
            title={s.runAsrHint}
            className="flex items-center gap-2 px-5 py-3 bg-white dark:bg-white/[0.06] border border-slate-300 dark:border-white/15 rounded-2xl text-[10px] font-black uppercase tracking-widest text-slate-600 dark:text-slate-300 hover:border-red-400 hover:text-red-600 active:scale-95 transition-all"
          >
            <ScanLine size={13} strokeWidth={3} /> {s.runAsr}
          </button>
          <p className="text-[9px] font-black uppercase tracking-widest text-slate-400 dark:text-slate-500 tabular-nums">
            {num(jobTotals.queued)} {s.queueQueued} · {num(jobTotals.running)} {s.queueRunning} ·{' '}
            {num(jobTotals.done)} {s.queueDone}
            {jobTotals.failed > 0 && <span className="text-red-600"> · {num(jobTotals.failed)} {s.queueFailed}</span>}
          </p>
        </div>

        {jobs.length === 0 ? (
          <p className="text-[10px] font-bold text-slate-400 dark:text-slate-500 py-6 text-center">{s.queueEmpty}</p>
        ) : (
          <div className="space-y-2">
            {jobs.slice(0, 40).map(j => (
              <div key={j.id} className="p-3 rounded-2xl bg-slate-50 dark:bg-black/40 border border-slate-100 dark:border-white/[0.08]">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                  <span className={`shrink-0 w-[6.5rem] truncate text-center px-2 py-1 rounded-lg border text-[8px] font-black uppercase tracking-widest ${stateStyles[j.state]}`}>
                    {stateLabel[j.state] || j.state}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-[11px] font-black text-slate-800 dark:text-slate-100 truncate">{j.label || j.kind}</p>
                    <p className="text-[9px] font-bold text-slate-400 dark:text-slate-500 truncate">
                      #{j.id} · {j.kind}
                      {j.attempts > 1 && ` · ${s.queueAttempt} ${j.attempts}/${j.max_attempts}`}
                    </p>
                  </div>
                  {j.state === 'running' && (
                    <div className="w-28 h-1.5 bg-slate-200 dark:bg-white/10 rounded-full overflow-hidden shrink-0">
                      <div className="h-full bg-red-600 rounded-full transition-all duration-500" style={{ width: `${Math.round(j.progress * 100)}%` }} />
                    </div>
                  )}
                  <div className="flex gap-2 shrink-0">
                    {(j.state === 'queued' || j.state === 'running') && (
                      <button onClick={() => handleJobAction(j.id, 'cancel')}
                        className="px-3 py-1.5 rounded-xl bg-white dark:bg-white/[0.06] border border-slate-200 dark:border-white/10 text-[9px] font-black uppercase tracking-widest text-slate-500 dark:text-slate-300 hover:border-red-300 hover:text-red-600 transition-colors">
                        {s.queueCancel}
                      </button>
                    )}
                    {(j.state === 'failed' || j.state === 'cancelled') && (
                      <button onClick={() => handleJobAction(j.id, 'retry')}
                        className="px-3 py-1.5 rounded-xl bg-white dark:bg-white/[0.06] border border-slate-200 dark:border-white/10 text-[9px] font-black uppercase tracking-widest text-slate-500 dark:text-slate-300 hover:border-red-300 hover:text-red-600 transition-colors">
                        {s.queueRetry}
                      </button>
                    )}
                  </div>
                </div>
                {j.detail && (
                  <p className={`text-[9px] font-bold leading-snug mt-2 break-words ${j.state === 'failed' ? 'text-red-500' : 'text-slate-400 dark:text-slate-500'}`}>
                    {j.detail}
                  </p>
                )}
              </div>
            ))}
          </div>
        )}
      </Panel>
    );
  };

  const renderPagesModal = (s: any, num: (n: number) => string) => {
    if (!pagesFor) return null;
    return (
      <div className="fixed inset-0 z-[600] flex items-end md:items-center justify-center p-0 md:p-5 bg-slate-900/40 backdrop-blur-xl">
        <div className="bg-white dark:bg-[#1c1c1e] w-full md:max-w-3xl rounded-t-[2rem] md:rounded-[2rem] border border-white dark:border-white/10 shadow-2xl overflow-hidden h-[90vh] md:max-h-[85vh] flex flex-col">
          <div className="p-5 border-b border-slate-100 dark:border-white/[0.08] flex justify-between items-start gap-4 shrink-0">
            <div className="min-w-0">
              <h3 className="text-sm font-black uppercase tracking-widest text-slate-900 dark:text-white truncate">{s.pagesTitle}</h3>
              <p className="text-[10px] font-bold text-slate-400 dark:text-slate-500 truncate mt-0.5">
                {pickText(pagesFor.title || undefined, lang, pagesFor.item_id)} · {pagesFor.filename}
              </p>
            </div>
            <button onClick={() => { setPagesFor(null); setEditingPage(null); }} className="p-2 bg-slate-50 dark:bg-white/[0.06] rounded-full hover:bg-red-50 dark:hover:bg-red-500/20 hover:text-red-600 shrink-0">
              <X size={18} />
            </button>
          </div>

          <p className="px-5 py-3 text-[10px] font-bold text-slate-500 dark:text-slate-400 bg-slate-50 dark:bg-black/40 border-b border-slate-100 dark:border-white/[0.08] shrink-0">
            {s.pagesManualNote}
          </p>

          <div className="p-4 md:p-5 overflow-y-auto flex-1 space-y-2">
            {pageRows.length === 0 && (
              <p className="text-[10px] font-bold text-slate-400 dark:text-slate-500 py-8 text-center">{s.pagesEmpty}</p>
            )}
            {pageRows.map(pg => (
              <div key={pg.page} className="rounded-2xl bg-slate-50 dark:bg-black/40 border border-slate-100 dark:border-white/[0.08] overflow-hidden">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3">
                  <span className="text-[10px] font-black text-slate-800 dark:text-slate-100 tabular-nums whitespace-nowrap">
                    {s.pagesPage} {pg.page || '—'}
                  </span>
                  {pg.page_label && (
                    <span className="text-[9px] font-black uppercase tracking-widest text-slate-400 dark:text-slate-500 whitespace-nowrap">
                      {s.pagesPrinted} «{pg.page_label}»
                    </span>
                  )}
                  {pg.source === 'manual' && (
                    <span className="px-2 py-0.5 rounded-lg bg-red-50 dark:bg-red-500/10 text-red-600 text-[8px] font-black uppercase tracking-widest">
                      {s.indexManual}
                    </span>
                  )}
                  <span className="ml-auto text-[9px] font-black uppercase tracking-widest tabular-nums text-slate-400 dark:text-slate-500 whitespace-nowrap">
                    {num(pg.chars)} {s.chars}
                    <span className={`ml-2 ${qualityTone(pg.quality)}`}>{pg.quality.toFixed(2)}</span>
                  </span>
                  <button
                    onClick={() => { setEditingPage(editingPage === pg.page ? null : pg.page); setPageDraft(pg.text); }}
                    className="px-3 py-1.5 rounded-xl bg-white dark:bg-white/[0.06] border border-slate-200 dark:border-white/10 text-[9px] font-black uppercase tracking-widest text-slate-500 dark:text-slate-300 hover:border-red-300 hover:text-red-600 transition-colors"
                  >
                    {s.pagesEdit}
                  </button>
                </div>
                {editingPage === pg.page ? (
                  <div className="px-4 pb-4 space-y-3">
                    <textarea
                      value={pageDraft}
                      onChange={e => setPageDraft(e.target.value)}
                      className="w-full h-64 resize-y bg-white dark:bg-black/30 border border-slate-300 dark:border-white/15 rounded-2xl p-4 text-[11px] font-mono leading-relaxed focus:border-red-600 outline-none hover:border-red-400 transition-colors"
                    />
                    <div className="flex gap-2">
                      <button
                        onClick={() => handleSavePage(pg.page)}
                        disabled={pagesBusy}
                        className="px-5 py-2.5 bg-red-600 hover:bg-red-700 text-white rounded-2xl text-[10px] font-black uppercase tracking-widest shadow-md disabled:opacity-40 active:scale-95 transition-all"
                      >
                        {s.pagesSave}
                      </button>
                      <button
                        onClick={() => setEditingPage(null)}
                        className="px-5 py-2.5 rounded-2xl bg-slate-100 dark:bg-white/[0.06] text-slate-600 dark:text-slate-300 text-[10px] font-black uppercase tracking-widest hover:bg-slate-200 dark:hover:bg-white/10 transition-colors"
                      >
                        {s.pagesCancel}
                      </button>
                    </div>
                  </div>
                ) : (
                  <p className="px-4 pb-4 text-[10px] font-mono text-slate-500 dark:text-slate-400 leading-relaxed line-clamp-3 whitespace-pre-wrap break-words">
                    {pg.text.slice(0, 400)}
                  </p>
                )}
              </div>
            ))}
            {pageRows.length < pageTotal && (
              <button
                onClick={loadMorePages}
                className="w-full py-3 rounded-2xl border-2 border-dashed border-slate-200 dark:border-white/10 text-[10px] font-black uppercase tracking-widest text-slate-400 hover:border-red-300 hover:text-red-600 transition-colors"
              >
                {pageRows.length} / {pageTotal}
              </button>
            )}
          </div>
        </div>
      </div>
    );
  };

  // ── Error log (built-in monitoring) ──────────────────────────────────────
  const [errorRows, setErrorRows] = useState<ErrorLogRow[]>([]);
  const [errorsLoading, setErrorsLoading] = useState(false);
  const [expandedError, setExpandedError] = useState<number | null>(null);

  const refreshErrors = async () => {
    setErrorsLoading(true);
    try { setErrorRows(await loadErrorLog()); }
    finally { setErrorsLoading(false); }
  };

  // Load the error log whenever the Data tab opens.
  useEffect(() => {
    if (activeTab === 'data' && isAdmin) refreshErrors();
  }, [activeTab, isAdmin]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleClearErrors = async () => {
    if (!confirm(ta.confirmClearErrors)) return;
    try {
      await clearErrorLog();
      setErrorRows([]);
      toast.success(ta.errorsCleared);
    } catch { /* toasted by db layer */ }
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
    // Ask our own server rather than an outside lookup service: it already
    // sees the address on the connection, and sending the operator's IP to a
    // third party just to learn it was a transfer with no purpose.
    let ip = '';
    try {
      const r = await fetch('/api/admin/whoami', { headers: { 'x-api-key': getServerApiKey() } });
      if (r.ok) ip = (await r.json()).ip || '';
    } catch { /* offline — leave blank, the other dimensions still apply */ }

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
      <div className="min-h-screen flex items-center justify-center px-6 bg-slate-50 dark:bg-black/40">
        <div className="w-full max-w-md bg-white/80 backdrop-blur-2xl border border-slate-200 dark:border-white/10 p-8 md:p-12 rounded-[2rem] md:rounded-[3rem] shadow-[0_25px_60px_rgba(0,0,0,0.1)] relative">
          <div className="absolute -top-8 left-1/2 -translate-x-1/2 bg-red-600 w-16 h-16 rounded-2xl flex items-center justify-center shadow-2xl shadow-red-200">
              <ShieldCheck size={32} className="text-white" />
          </div>
          <h2 className="text-xl md:text-2xl font-black text-center mb-2 mt-8 tracking-tighter uppercase text-slate-900 dark:text-white">{t.adminAccess}</h2>
          <p className="text-slate-400 dark:text-slate-500 text-center mb-8 text-[10px] font-black uppercase tracking-[0.2em]">{ta.authorizedOnly}</p>
          <form onSubmit={handleAdminLogin} className="space-y-4">
            <div className="space-y-1">
                <label className="text-[9px] font-black uppercase tracking-widest text-slate-400 dark:text-slate-500 ml-2">{t.apiKey}</label>
                <input
                    type="password"
                    placeholder="••••••••"
                    className="w-full bg-slate-50 dark:bg-black/40 border border-slate-200 dark:border-white/10 rounded-2xl py-4 px-6 focus:ring-4 focus:ring-red-500/5 focus:border-red-600 outline-none transition-all font-mono text-sm"
                    value={apiKeyInput} onChange={e => setApiKeyInput(e.target.value)}
                />
            </div>
            <button disabled={loginLoading} className="w-full bg-red-600 py-4 rounded-[2rem] font-black text-white uppercase tracking-widest shadow-xl shadow-red-200 transition-all active:scale-95 hover:bg-red-700 text-xs disabled:opacity-60">
                {loginLoading ? '...' : t.accessDashboard}
            </button>
            <button type="button" onClick={onBack} className="w-full text-slate-400 dark:text-slate-500 font-black text-[9px] uppercase tracking-[0.3em] hover:text-red-600 transition-colors py-2">
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
          <h1 className="text-2xl md:text-3xl font-black text-slate-900 dark:text-white tracking-tighter uppercase leading-none mb-1">Control<span className="text-red-600">Center</span></h1>
          <p className="text-[8px] md:text-[9px] font-black text-slate-400 dark:text-slate-500 uppercase tracking-[0.4em]">{t.adminTerminal}</p>
        </div>
        <button onClick={onLogout} className="p-3 md:p-4 bg-white dark:bg-[#1c1c1e] rounded-2xl text-red-600 border border-slate-200 dark:border-white/10 shadow-sm active:scale-95 transition-all">
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
          {(['stats', 'security', 'items', 'scan', 'types', 'data'] as const).map(tab => (
            <button 
              key={tab} 
              data-active={activeTab === tab}
              onClick={() => setActiveTab(tab)} 
              className={`
                flex-shrink-0 snap-start px-5 py-2.5 rounded-2xl text-[10px] md:text-xs font-black uppercase tracking-widest transition-all duration-300 border whitespace-nowrap
                ${activeTab === tab 
                  ? 'bg-red-600 border-red-600 text-white shadow-lg shadow-red-200' 
                  : 'bg-white dark:bg-[#1c1c1e] border-slate-200 dark:border-white/10 text-slate-400 dark:text-slate-500 hover:border-red-200 hover:text-red-600'
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
        {activeTab === 'scan' && (() => {
          const s = ta.scan;
          const job = scanReport?.job;
          const label = (st: string) => s[`state${st[0].toUpperCase()}${st.slice(1)}`] || st;
          const hint = (st: string) => s[`state${st[0].toUpperCase()}${st.slice(1)}Hint`] || '';
          const num = (n: number) => n.toLocaleString(lang === 'ru' ? 'ru-RU' : lang);
          const pct = job?.total ? Math.round((job.done / job.total) * 100) : 0;
          // The in-process job knows when *this* process last finished a pass;
          // the rows know when a pass last happened at all. Prefer the former
          // while it exists, fall back to the latter across restarts.
          const lastRunAt = scanReport?.job?.finishedAt || scanReport?.lastScanAt || null;
          const catalog = scanReport?.catalog || { items: 0, formats: 0, videos: 0, articles: 0 };
          const scanned = scanReport?.scanned || { items: 0, formats: 0, videos: 0, articles: 0 };
          // Entries without a URL are never walked, so a small shortfall can be
          // legitimate — the message says so rather than crying error.
          const coverageStale = !job?.running && (
            scanned.items < catalog.items ||
            scanned.formats < catalog.formats ||
            scanned.videos < catalog.videos ||
            scanned.articles < catalog.articles
          );
          const cards = [
            { key: 'ready',     value: scanCounts.ready,     title: s.readyTitle,     desc: s.readyDesc,     tone: 'text-emerald-600' },
            { key: 'ocr',       value: scanCounts.ocr,       title: s.ocrTitle,       desc: s.ocrDesc,       tone: 'text-red-600' },
            { key: 'attention', value: scanCounts.attention, title: s.attentionTitle, desc: s.attentionDesc, tone: 'text-amber-600' },
            { key: 'later',     value: scanCounts.later,     title: s.laterTitle,     desc: s.laterDesc,     tone: 'text-slate-400' },
          ];

          return (
            <div className="space-y-5 md:space-y-6 animate-in slide-in-from-bottom-4 duration-500">

              {renderIndexPanel(s, num)}

              <Panel
                icon={<ScanLine size={18} strokeWidth={2.5} />}
                title={s.sectionCheck}
                subtitle={s.sectionCheckSub}
                badge={scanCounts.total ? `${num(scanCounts.total)} ${s.records}` : undefined}
                open={openCheck}
                onToggle={() => setOpenCheck(v => !v)}
              >
                <p className="text-[10px] md:text-xs text-slate-500 dark:text-slate-400 font-bold leading-relaxed max-w-3xl mb-6">{s.intro}</p>

                <div className="flex flex-wrap items-center gap-3 mb-4">
                  {job?.running ? (
                    <button
                      onClick={handleScanStop}
                      className="flex items-center gap-2 px-5 py-3 bg-slate-800 dark:bg-white/10 text-white rounded-2xl text-[10px] font-black uppercase tracking-widest shadow-md active:scale-95 transition-all"
                    >
                      <Square size={13} strokeWidth={3} /> {s.stop}
                    </button>
                  ) : (
                    <button
                      onClick={handleScanRun}
                      className="flex items-center gap-2 px-5 py-3 bg-red-600 hover:bg-red-700 text-white rounded-2xl text-[10px] font-black uppercase tracking-widest shadow-md active:scale-95 transition-all"
                    >
                      <Play size={13} strokeWidth={3} /> {lastRunAt ? s.rerun : s.run}
                    </button>
                  )}
                  <p className="text-[9px] font-black uppercase tracking-widest text-slate-400 dark:text-slate-500">
                    {job?.running
                      ? `${s.running} · ${num(job.done)} ${s.progress} ${num(job.total)}`
                      : lastRunAt
                        ? `${s.lastRun}: ${new Date(lastRunAt).toLocaleString(lang === 'ru' ? 'ru-RU' : lang)}${job?.stopRequested ? ` · ${s.stopped}` : ''}`
                        : s.never}
                  </p>
                </div>

                {job?.running && (
                  <>
                    <div className="h-1.5 w-full bg-slate-100 dark:bg-white/10 rounded-full overflow-hidden mb-2">
                      <div className="h-full bg-red-600 rounded-full transition-all duration-500" style={{ width: `${pct}%` }} />
                    </div>
                    {job.current && (
                      <p className="text-[9px] text-slate-400 dark:text-slate-500 font-bold truncate mb-4">{job.current}</p>
                    )}
                  </>
                )}

                {job?.error && (
                  <p className="text-[10px] font-bold text-red-600 bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/25 rounded-2xl px-4 py-3 mb-4 break-words">
                    {s.failed}: {job.error}
                  </p>
                )}

                <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                  {cards.map(c => (
                    <div key={c.key} className="p-4 rounded-3xl bg-slate-50 dark:bg-black/40 border border-slate-100 dark:border-white/[0.08]">
                      <p className={`text-2xl md:text-3xl font-black tracking-tighter tabular-nums ${c.tone}`}>{num(c.value)}</p>
                      <p className="text-[9px] font-black uppercase tracking-widest text-slate-700 dark:text-slate-300 mt-1">{c.title}</p>
                      <p className="text-[9px] text-slate-400 dark:text-slate-500 font-bold leading-snug mt-1">{c.desc}</p>
                    </div>
                  ))}
                </div>

                {scanCounts.total > 0 && (
                  <p className="text-[9px] font-black uppercase tracking-widest text-slate-400 dark:text-slate-500 mt-4">
                    {num(scanCounts.total)} {s.records} · {num(scanCounts.pages)} {s.pages} · {num(scanCounts.chars)} {s.chars}
                  </p>
                )}

                {/* What the catalogue holds, against what the last pass walked.
                    "No article rows" is ambiguous on its own — no articles, or a
                    pass that predates article support — and those need different
                    actions, so the screen tells them apart. */}
                <div className="mt-4 grid gap-1 text-[9px] font-black uppercase tracking-widest">
                  <p className="text-slate-400 dark:text-slate-500">
                    <span className="text-slate-600 dark:text-slate-300">{s.coverageCatalog}:</span>{' '}
                    {num(catalog.items)} {s.coverageItems} · {num(catalog.formats)} {s.coverageFiles} ·{' '}
                    {num(catalog.videos)} {s.coverageVideos} · {num(catalog.articles)} {s.coverageArticles}
                  </p>
                  <p className="text-slate-400 dark:text-slate-500">
                    <span className="text-slate-600 dark:text-slate-300">{s.coverageScanned}:</span>{' '}
                    {num(scanned.items)} {s.coverageItems} · {num(scanned.formats)} {s.coverageFiles} ·{' '}
                    {num(scanned.videos)} {s.coverageVideos} · {num(scanned.articles)} {s.coverageArticles}
                  </p>
                </div>
                {coverageStale && (
                  <p className="mt-3 text-[10px] font-bold text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/25 rounded-2xl px-4 py-3 max-w-3xl">
                    {s.coverageStale}
                  </p>
                )}

                <p className="text-[9px] text-slate-400 dark:text-slate-500 font-bold leading-relaxed mt-3 max-w-3xl">{s.videoNote}</p>

                <div className="h-px bg-slate-100 dark:bg-white/[0.08] my-6" />

                <div className="flex gap-2 overflow-x-auto no-scrollbar pb-3 mb-4">
                  {(['all', ...SCAN_STATE_ORDER] as const)
                    .filter(st => st === 'all' || (scanCounts.by[st] || 0) > 0)
                    .map(st => (
                      <button
                        key={st}
                        onClick={() => setScanFilter(st as 'all' | ContentScanState)}
                        className={`flex-shrink-0 px-4 py-2 rounded-2xl text-[9px] font-black uppercase tracking-widest border transition-all whitespace-nowrap
                          ${scanFilter === st
                            ? 'bg-red-600 border-red-600 text-white shadow-md'
                            : 'bg-white dark:bg-black/30 border-slate-200 dark:border-white/10 text-slate-400 dark:text-slate-500 hover:border-red-300 hover:text-red-600'}`}
                      >
                        {st === 'all' ? `${s.all} · ${num(scanCounts.total)}` : `${label(st)} · ${num(scanCounts.by[st] || 0)}`}
                      </button>
                    ))}
                </div>

                {scanRows.length === 0 ? (
                  <p className="text-[10px] font-bold text-slate-400 dark:text-slate-500 py-6 text-center">{s.empty}</p>
                ) : (
                  <div className="space-y-2">
                    {scanRows.map((r: ContentScanRow) => (
                      <div
                        key={`${r.item_id}::${r.format_url}`}
                        className="flex flex-wrap items-center gap-x-3 gap-y-1 p-3 rounded-2xl bg-slate-50 dark:bg-black/40 border border-slate-100 dark:border-white/[0.08]"
                      >
                        {/* Fixed width so the titles line up: a ragged left edge makes
                            a list of verdicts much harder to skim than it needs to be. */}
                        <span className={`shrink-0 w-[7.5rem] truncate text-center px-2 py-1 rounded-lg border text-[8px] font-black uppercase tracking-widest ${SCAN_STATE_STYLES[r.state] || SCAN_STATE_STYLES.unsupported}`}>
                          {label(r.state)}
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className="text-[11px] font-black text-slate-800 dark:text-slate-100 truncate">
                            {pickText(r.title || undefined, lang, r.item_id)}
                          </p>
                          <p className="text-[9px] font-bold text-slate-400 dark:text-slate-500 truncate">
                            {r.filename || r.format_url}
                          </p>
                        </div>
                        <p className="text-[9px] font-black uppercase tracking-widest text-slate-400 dark:text-slate-500 tabular-nums whitespace-nowrap">
                          {r.pages ? `${num(r.pages)} ${s.pages}` : ''}
                          {r.pages && r.chars ? ' · ' : ''}
                          {r.chars ? `${num(r.chars)} ${s.chars}` : ''}
                          {r.pages && r.chars ? ` · ${num(Math.round(r.chars / r.pages))} ${s.perPage}` : ''}
                        </p>
                        {(r.detail || hint(r.state)) && (
                          <p className="w-full text-[9px] font-bold text-slate-400 dark:text-slate-500 leading-snug break-words">
                            {r.detail || hint(r.state)}
                          </p>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </Panel>

              {renderMetricPanel(s, num)}

              {renderQueuePanel(s, num)}

              {renderPagesModal(s, num)}
            </div>
          );
        })()}

        {activeTab === 'security' && (
          <div className="space-y-6 md:space-y-8 animate-in slide-in-from-bottom-4 duration-500">
             
            {/* 1. Global Access Control (Moved from Users) */}
            <div className="bg-white dark:bg-[#1c1c1e] p-5 md:p-8 rounded-[2rem] border border-slate-100 dark:border-white/[0.08] shadow-sm">
                <h3 className="text-xs md:text-sm font-black mb-6 flex items-center gap-3 text-slate-900 dark:text-white uppercase tracking-widest underline decoration-red-600 decoration-4 underline-offset-8">
                   {t.publicAccessControl}
                </h3>
                <div className="flex items-center justify-between">
                   <div className="flex items-center gap-4">
                      <div className={`p-3 rounded-2xl ${db.globalAccess ? 'bg-green-50 text-green-600' : 'bg-red-50 text-red-600'}`}>
                         {db.globalAccess ? <Unlock size={20} /> : <Lock size={20} />}
                      </div>
                      <div>
                         <h3 className="text-xs font-black uppercase tracking-widest">{t.globalStatus}</h3>
                         <p className="text-[8px] font-black text-slate-400 dark:text-slate-500 uppercase">{db.globalAccess ? 'Open to Public' : 'Whitelist Only'}</p>
                      </div>
                   </div>
                   <label className="relative inline-flex items-center cursor-pointer">
                      <input type="checkbox" className="sr-only peer" checked={db.globalAccess} onChange={handleToggleGlobal} />
                      <div className="w-12 h-7 bg-slate-200 dark:bg-white/10 peer-focus:outline-none rounded-full peer peer-checked:bg-red-600 transition-all after:content-[''] after:absolute after:top-[4px] after:left-[4px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:after:translate-x-full"></div>
                   </label>
                </div>
            </div>

            {/* 2. Whitelist Management (Moved from Users) */}
            <div className="bg-white dark:bg-[#1c1c1e] p-5 md:p-8 rounded-[2rem] border border-slate-100 dark:border-white/[0.08] shadow-sm">
                 <h3 className="text-xs md:text-sm font-black mb-6 flex items-center gap-3 text-slate-900 dark:text-white uppercase tracking-widest underline decoration-red-600 decoration-4 underline-offset-8">
                   {t.users} (Whitelist)
                 </h3>
                 <div className="flex gap-2 mb-6">
                    <input 
                      type="text" placeholder={ta.telegramUsername} className="flex-1 bg-slate-50 dark:bg-black/40 border border-slate-100 dark:border-white/[0.08] rounded-2xl px-4 py-3 text-xs font-black uppercase focus:border-red-600 outline-none"
                      value={newUserNickname} onChange={e => setNewUserNickname(e.target.value)}
                    />
                    <button onClick={handleAddUser} className="bg-red-600 text-white px-6 rounded-2xl font-black uppercase text-[10px] tracking-widest hover:bg-red-700 transition-colors">{ta.add}</button>
                 </div>
                 
                 <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                    {db.allowedUsers.length > 0 ? db.allowedUsers.map(u => (
                       <div key={u} className="flex justify-between items-center p-3 bg-slate-50 dark:bg-black/40 rounded-2xl border border-slate-100 dark:border-white/[0.08] group hover:border-red-100 transition-all">
                          <div className="flex items-center gap-2">
                             <div className="bg-white dark:bg-[#1c1c1e] p-1.5 rounded-lg text-slate-400 dark:text-slate-500"><Users size={12}/></div>
                             <span className="text-xs font-bold text-slate-700 dark:text-slate-200">@{u}</span>
                          </div>
                          <button onClick={() => handleRemoveUser(u)} className="p-2 bg-white dark:bg-[#1c1c1e] rounded-xl text-slate-300 dark:text-slate-600 hover:text-red-600 transition-colors"><Trash2 size={14} /></button>
                       </div>
                    )) : (
                        <p className="text-[10px] uppercase font-black text-slate-400 dark:text-slate-500 col-span-2 text-center py-4">{ta.whitelistEmpty}</p>
                    )}
                 </div>
            </div>

            {/* 3. Blacklist Management */}
            <div className="bg-white dark:bg-[#1c1c1e] p-5 md:p-8 rounded-[2rem] border border-slate-100 dark:border-white/[0.08] shadow-sm">
                  <h3 className="text-xs md:text-sm font-black mb-6 flex items-center gap-3 text-red-600 uppercase tracking-widest underline decoration-red-200 decoration-4 underline-offset-8">
                      <Ban size={18} /> {t.blacklist}
                  </h3>
                  
                  <div className="flex gap-2 md:gap-3 mb-6 md:mb-8">
                      <div className="relative flex-1">
                          <ShieldAlert className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 dark:text-slate-500" size={16} />
                          <input 
                          type="text" 
                          placeholder="@username / IP" 
                          className="w-full bg-slate-50 dark:bg-black/40 border border-slate-100 dark:border-white/[0.08] rounded-2xl pl-10 pr-4 py-3 md:py-4 text-xs font-black uppercase tracking-widest focus:ring-2 focus:ring-red-600/10 focus:border-red-600 outline-none transition-all"
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
                                  className="px-3 py-1.5 bg-white dark:bg-[#1c1c1e] text-red-600 text-[9px] font-bold uppercase rounded-lg shadow-sm hover:bg-red-600 hover:text-white transition-colors shrink-0"
                              >
                                  {t.unblock}
                              </button>
                          </div>
                      ))}
                      {(!db.blacklist || db.blacklist.length === 0) && (
                          <p className="col-span-2 text-center text-[10px] text-slate-400 dark:text-slate-500 font-bold uppercase py-6">{ta.blacklistEmpty}</p>
                      )}
                  </div>
            </div>

            {/* 4. Access Logs */}
            <div className="bg-white dark:bg-[#1c1c1e] p-5 md:p-8 rounded-[2rem] border border-slate-100 dark:border-white/[0.08] shadow-sm overflow-hidden">
                <h3 className="text-[10px] font-black uppercase tracking-widest text-slate-900 dark:text-white mb-6 flex items-center gap-2">
                      <Monitor size={14} className="text-blue-600" /> {t.accessLogs}
                </h3>
                <div className="overflow-x-auto overflow-y-auto max-h-[420px]">
                    {/* min-width grew with the date column so the five columns
                        don't cramp on a phone; the wrapper scrolls horizontally. */}
                    <table className="w-full text-left border-collapse min-w-[590px]">
                        <thead className="sticky top-0 z-10 bg-white dark:bg-[#1c1c1e]">
                            <tr className="border-b border-slate-100 dark:border-white/[0.08]">
                                <th className="p-3 text-[9px] font-black uppercase text-slate-400 dark:text-slate-500 tracking-widest bg-white dark:bg-[#1c1c1e]">{ta.date}</th>
                                <th className="p-3 text-[9px] font-black uppercase text-slate-400 dark:text-slate-500 tracking-widest bg-white dark:bg-[#1c1c1e]">{ta.time}</th>
                                <th className="p-3 text-[9px] font-black uppercase text-slate-400 dark:text-slate-500 tracking-widest bg-white dark:bg-[#1c1c1e]">{ta.user}</th>
                                <th className="p-3 text-[9px] font-black uppercase text-slate-400 dark:text-slate-500 tracking-widest bg-white dark:bg-[#1c1c1e]">{t.ipAddress}</th>
                                <th className="p-3 text-[9px] font-black uppercase text-slate-400 dark:text-slate-500 tracking-widest text-right bg-white dark:bg-[#1c1c1e]">{t.device}</th>
                            </tr>
                        </thead>
                        <tbody className="text-[10px] font-mono">
                            {db.visitLogs && db.visitLogs.slice(0, 50).map(log => (
                                <tr key={log.id} className="border-b border-slate-50 hover:bg-slate-50 transition-colors">
                                    <td className="p-3 text-slate-400 dark:text-slate-500 whitespace-nowrap">{new Date(log.timestamp).toLocaleDateString()}</td>
                                    <td className="p-3 text-slate-400 dark:text-slate-500 whitespace-nowrap">{new Date(log.timestamp).toLocaleTimeString()}</td>
                                    <td className="p-3 font-bold text-slate-700 dark:text-slate-200">
                                      <span className="inline-flex items-center gap-1.5">
                                        {log.username?.startsWith('id_') ? `ID ${log.username.slice(3)}` : log.username}
                                        {/* Exclude exactly this visitor, keyed on their identity rather
                                            than their address: a Telegram id / @handle names one person
                                            and survives an IP change. Absent for anonymous rows — there
                                            the only handle is the anonymised IP, which would cover the
                                            whole subnet, so we offer nothing rather than over-reach. */}
                                        {(() => {
                                          const key = visitorExcludeKey(log.username);
                                          if (!key) return null;
                                          const already = key.kind === 'id'
                                            ? (db.analyticsExcludes?.userIds || []).includes(key.value)
                                            : (db.analyticsExcludes?.usernames || []).includes(key.value);
                                          if (already) return null;
                                          return (
                                            <button
                                              onClick={() => handleExcludeVisitor(key)}
                                              title={ta.excludeThisVisitor}
                                              aria-label={ta.excludeThisVisitor}
                                              className="text-slate-300 dark:text-slate-600 hover:text-red-600 transition-colors"
                                            >
                                              <Ban size={11} strokeWidth={3} />
                                            </button>
                                          );
                                        })()}
                                      </span>
                                    </td>
                                    <td className="p-3 text-slate-500 dark:text-slate-400">
                                      <span className="inline-flex items-center gap-2">
                                        {log.ip}
                                        {/* Pseudonym: same swatch + code = same visitor. The address
                                            itself stays truncated, so this is what distinguishes two
                                            people who share a /24 — and what an exclude can target. */}
                                        {log.ip_hash && (() => {
                                          const excluded = (db.analyticsExcludes?.visitors || []).includes(log.ip_hash!);
                                          return (
                                            <button
                                              type="button"
                                              onClick={() => !excluded && handleExcludeVisitorHash(log.ip_hash!)}
                                              disabled={excluded}
                                              title={excluded ? ta.visitorExcludedAlready : ta.excludeThisVisitor}
                                              className={`inline-flex items-center gap-1.5 px-1.5 py-0.5 rounded-md border transition-colors ${
                                                excluded
                                                  ? 'border-slate-200 dark:border-white/10 opacity-45 cursor-default'
                                                  : 'border-slate-200 dark:border-white/10 hover:border-red-400 hover:text-red-600'
                                              }`}
                                            >
                                              <span className="w-2 h-2 rounded-sm shrink-0" style={{ background: visitorTint(log.ip_hash!) }} />
                                              <span className="text-[9px] font-bold tracking-wider">{log.ip_hash!.slice(0, 6)}</span>
                                            </button>
                                          );
                                        })()}
                                      </span>
                                    </td>
                                    <td className="p-3 text-right text-slate-400 dark:text-slate-500 truncate max-w-[150px]">{log.platform}</td>
                                </tr>
                            ))}
                            {(!db.visitLogs || db.visitLogs.length === 0) && (
                                <tr><td colSpan={5} className="p-8 text-center text-slate-400 dark:text-slate-500">{ta.noLogs}</td></tr>
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
              <div className="bg-white dark:bg-[#1c1c1e] p-4 md:p-6 rounded-[2rem] border border-slate-100 dark:border-white/[0.08] shadow-sm relative overflow-hidden group">
                <div className="relative z-10">
                  <p className="text-[8px] md:text-[9px] font-black text-slate-400 dark:text-slate-500 uppercase tracking-widest mb-1">{t.totalViews}</p>
                  <p className="text-2xl md:text-4xl font-black text-slate-900 dark:text-white tracking-tighter">{analytics.totalViews}</p>
                </div>
                <Eye className="absolute -right-2 -bottom-2 text-slate-50 opacity-50 md:opacity-100 group-hover:text-red-50 transition-colors" size={60} />
              </div>
              <div className="bg-white dark:bg-[#1c1c1e] p-4 md:p-6 rounded-[2rem] border border-slate-100 dark:border-white/[0.08] shadow-sm relative overflow-hidden group">
                <div className="relative z-10">
                  <p className="text-[8px] md:text-[9px] font-black text-slate-400 dark:text-slate-500 uppercase tracking-widest mb-1">{t.totalDownloads}</p>
                  <p className="text-2xl md:text-4xl font-black text-slate-900 dark:text-white tracking-tighter">{analytics.totalDownloads}</p>
                </div>
                <Download className="absolute -right-2 -bottom-2 text-slate-50 opacity-50 md:opacity-100 group-hover:text-green-50 transition-colors" size={60} />
              </div>
              <div className="bg-white dark:bg-[#1c1c1e] p-4 md:p-6 rounded-[2rem] border border-slate-100 dark:border-white/[0.08] shadow-sm relative overflow-hidden group col-span-2 md:col-span-1">
                <div className="relative z-10">
                  <p className="text-[8px] md:text-[9px] font-black text-slate-400 dark:text-slate-500 uppercase tracking-widest mb-1">{t.conversion}</p>
                  <p className="text-2xl md:text-4xl font-black text-slate-900 dark:text-white tracking-tighter">{analytics.conversionRate}%</p>
                </div>
                <Percent className="absolute -right-2 -bottom-2 text-slate-50 opacity-50 md:opacity-100 group-hover:text-blue-50 transition-colors" size={60} />
              </div>
            </div>

            {/* Engagement Graph */}
            <div className="bg-white dark:bg-[#1c1c1e] p-5 md:p-8 rounded-[2rem] border border-slate-100 dark:border-white/[0.08] shadow-sm">
               <div className="flex items-center justify-between mb-4">
                  <h3 className="text-[10px] font-black uppercase tracking-widest text-slate-900 dark:text-white flex items-center gap-2">
                     <BarChart4 size={14} className="text-slate-400 dark:text-slate-500"/> Activity Timeline
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
                <div className="bg-white dark:bg-[#1c1c1e] p-5 md:p-8 rounded-[2rem] border border-slate-100 dark:border-white/[0.08] shadow-sm">
                    <h3 className="text-[10px] font-black uppercase tracking-widest text-slate-900 dark:text-white mb-6 flex items-center gap-2">
                        <Eye size={14} className="text-red-600" /> {t.hotAssets}
                    </h3>
                    <div className="space-y-3">
                        {analytics.topViews.map((item, idx) => (
                        <div key={item.id} className="flex items-center justify-between p-3 bg-slate-50 dark:bg-black/40 rounded-2xl border border-slate-100 dark:border-white/[0.08] hover:border-red-100 transition-all group">
                            <div className="flex items-center gap-3 overflow-hidden">
                                <span className="text-[10px] font-black text-slate-300 dark:text-slate-600 shrink-0">#{idx + 1}</span>
                                <div className="w-8 h-10 rounded-md overflow-hidden shrink-0">
                                   <CardCover item={item} lang={lang} />
                                </div>
                                <div className="min-w-0">
                                    <p className="text-xs font-black text-slate-900 dark:text-white tracking-tight group-hover:text-red-600 truncate">{pickText(item.title, lang)}</p>
                                    <p className="text-[8px] font-black text-slate-400 dark:text-slate-500 uppercase">{item.type}</p>
                                </div>
                            </div>
                            <div className="text-right shrink-0">
                                <p className="text-sm font-black text-slate-900 dark:text-white">{item.views}</p>
                                <p className="text-[8px] font-black text-slate-400 dark:text-slate-500 uppercase">{ta.hits}</p>
                            </div>
                        </div>
                        ))}
                         {analytics.topViews.length === 0 && <p className="text-center text-xs text-slate-300 dark:text-slate-600 font-bold uppercase py-4">{ta.noData}</p>}
                    </div>
                </div>

                {/* High Utility (Downloads) */}
                <div className="bg-white dark:bg-[#1c1c1e] p-5 md:p-8 rounded-[2rem] border border-slate-100 dark:border-white/[0.08] shadow-sm">
                    <h3 className="text-[10px] font-black uppercase tracking-widest text-slate-900 dark:text-white mb-6 flex items-center gap-2">
                        <Download size={14} className="text-green-600" /> {t.highUtility}
                    </h3>
                    <div className="space-y-3">
                        {analytics.topDownloads.map((item, idx) => (
                        <div key={item.id} className="flex items-center justify-between p-3 bg-slate-50 dark:bg-black/40 rounded-2xl border border-slate-100 dark:border-white/[0.08] hover:border-green-100 transition-all group">
                            <div className="flex items-center gap-3 overflow-hidden">
                                <span className="text-[10px] font-black text-slate-300 dark:text-slate-600 shrink-0">#{idx + 1}</span>
                                <div className="w-8 h-10 rounded-md overflow-hidden shrink-0">
                                   <CardCover item={item} lang={lang} />
                                </div>
                                <div className="min-w-0">
                                    <p className="text-xs font-black text-slate-900 dark:text-white tracking-tight group-hover:text-green-600 truncate">{pickText(item.title, lang)}</p>
                                    <p className="text-[8px] font-black text-slate-400 dark:text-slate-500 uppercase">{item.type}</p>
                                </div>
                            </div>
                            <div className="text-right shrink-0">
                                <p className="text-sm font-black text-slate-900 dark:text-white">{item.downloads}</p>
                                <p className="text-[8px] font-black text-slate-400 dark:text-slate-500 uppercase">{ta.files}</p>
                            </div>
                        </div>
                        ))}
                        {analytics.topDownloads.length === 0 && <p className="text-center text-xs text-slate-300 dark:text-slate-600 font-bold uppercase py-4">{ta.noData}</p>}
                    </div>
                </div>
            </div>

            {/* NEW: User Leaderboard (Restored) */}
            <div className="bg-white dark:bg-[#1c1c1e] p-5 md:p-8 rounded-[2rem] border border-slate-100 dark:border-white/[0.08] shadow-sm">
                <h3 className="text-[10px] font-black uppercase tracking-widest text-slate-900 dark:text-white mb-6 flex items-center gap-2">
                    <Trophy size={14} className="text-yellow-500" /> {t.userLeaderboard}
                </h3>
                <div className="overflow-x-auto">
                    <table className="w-full text-left border-collapse min-w-[300px]">
                        <thead>
                            <tr className="border-b border-slate-100 dark:border-white/[0.08]">
                                <th className="p-3 text-[8px] font-black uppercase text-slate-400 dark:text-slate-500 tracking-widest">{ta.rank}</th>
                                <th className="p-3 text-[8px] font-black uppercase text-slate-400 dark:text-slate-500 tracking-widest">{ta.user}</th>
                                <th className="p-3 text-[8px] font-black uppercase text-slate-400 dark:text-slate-500 tracking-widest">{ta.interests}</th>
                                <th className="p-3 text-[8px] font-black uppercase text-slate-400 dark:text-slate-500 tracking-widest text-right">{ta.activity}</th>
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
                                    <td className="p-3 text-[10px] font-black text-slate-300 dark:text-slate-600">#{idx + 1}</td>
                                    <td className="p-3">
                                        {(() => {
                                          // Identifier shape from /api/items/:itemId/track:
                                          //   real @handles  → plain string (lowercased)
                                          //   no-handle Telegram users → `id_<numericId>`
                                          //   pre-fallback / non-Telegram traffic → 'anonymous'
                                          // Display them differently so admins can tell which is which at a glance.
                                          const isAnon = user.username === 'anonymous';
                                          const isId = !isAnon && user.username.startsWith('id_');
                                          const labelMain = isAnon ? ta.anonymousVisitors : isId ? `ID ${user.username.slice(3)}` : `@${user.username}`;
                                          const avatar = isAnon ? '?' : isId ? '#' : user.username.slice(0, 2);
                                          return (
                                            <div className="flex items-center gap-2">
                                                <div className="w-6 h-6 rounded-full bg-slate-100 dark:bg-white/[0.06] flex items-center justify-center text-slate-500 dark:text-slate-400 font-bold uppercase text-[8px]">{avatar}</div>
                                                <div>
                                                    <p className="text-[10px] font-bold text-slate-700 dark:text-slate-200 group-hover:text-blue-600 transition-colors">{labelMain}</p>
                                                    <p className="text-[8px] text-slate-400 dark:text-slate-500">{user.lastActive}</p>
                                                </div>
                                            </div>
                                          );
                                        })()}
                                    </td>
                                    <td className="p-3">
                                        <div className="flex flex-wrap gap-1">
                                            {uniqueTypes.length > 0 ? uniqueTypes.map(type => (
                                                <span key={type} className="text-[7px] font-black uppercase bg-red-50 text-red-600 px-1.5 py-0.5 rounded">{type}</span>
                                            )) : <span className="text-[8px] text-slate-300 dark:text-slate-600">—</span>}
                                        </div>
                                    </td>
                                    <td className="p-3 text-right">
                                        <p className="text-xs font-black text-slate-900 dark:text-white">{user.views + user.downloads}</p>
                                        <p className="text-[8px] text-slate-400 dark:text-slate-500">{user.views}👁 {user.downloads}⬇</p>
                                    </td>
                                </tr>
                                );
                            }) : (
                                <tr><td colSpan={4} className="p-8 text-center text-xs text-slate-400 dark:text-slate-500 font-bold uppercase tracking-widest">{ta.noUserData}</td></tr>
                            )}
                        </tbody>
                    </table>
                </div>
            </div>

            {/* Traffic Analytics Block */}
            <div className="bg-white dark:bg-[#1c1c1e] p-5 md:p-8 rounded-[2rem] border border-slate-100 dark:border-white/[0.08] shadow-sm">
                <h3 className="text-xs md:text-sm font-black mb-6 flex items-center gap-3 text-slate-900 dark:text-white uppercase tracking-widest underline decoration-red-600 decoration-4 underline-offset-8">
                  {t.trafficAnalytics}
                </h3>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3 md:gap-4">
                   {(['day', 'week', 'month', 'year'] as const).map(period => (
                       <div key={period} className="p-4 md:p-5 bg-slate-50 dark:bg-black/40 rounded-2xl border border-slate-100 dark:border-white/[0.08] relative overflow-hidden">
                          <p className="text-[8px] md:text-[9px] font-black text-slate-400 dark:text-slate-500 uppercase tracking-widest mb-2">{t[period]}</p>
                          <div className="flex justify-between items-end relative z-10">
                              <div>
                                  <p className="text-lg md:text-2xl font-black text-slate-900 dark:text-white">{trafficStats[period].total}</p>
                                  <p className="text-[7px] md:text-[8px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-wider">{t.totalVisits}</p>
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
            <div className="bg-white dark:bg-[#1c1c1e] p-5 md:p-8 rounded-[2rem] border border-slate-100 dark:border-white/[0.08] shadow-sm">
              <div className="flex items-center gap-4 mb-6">
                <div className="p-3 bg-red-50 text-red-600 rounded-2xl"><GitBranch size={24} /></div>
                <div>
                  <h3 className="text-sm font-black text-slate-900 dark:text-white uppercase tracking-widest">{ta.deployTitle}</h3>
                  <p className="text-[9px] font-black text-slate-400 dark:text-slate-500 uppercase tracking-widest mt-1">{ta.deploySubtitle}</p>
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
                    <div className="p-5 bg-slate-50 dark:bg-black/40 rounded-3xl border border-slate-100 dark:border-white/[0.08] space-y-3">
                      {offline ? (
                        <p className="text-[10px] font-bold text-slate-400 dark:text-slate-500 flex items-center gap-2">
                          <AlertCircle size={14} className="text-amber-500" /> {ta.agentOffline}
                        </p>
                      ) : (
                        <>
                          <div className="flex items-center justify-between">
                            <span className="text-[9px] font-black uppercase tracking-widest text-slate-400 dark:text-slate-500">{ta.statusLabel}</span>
                            {deploying ? (
                              <span className="text-[10px] font-black text-blue-600 flex items-center gap-1.5"><RefreshCw size={12} className="animate-spin" /> {ta.deployingStatus}</span>
                            ) : ds?.behind ? (
                              <span className="text-[10px] font-black text-amber-600 flex items-center gap-1.5"><AlertCircle size={12} /> {ta.hasUpdates}</span>
                            ) : (
                              <span className="text-[10px] font-black text-green-600 flex items-center gap-1.5"><CheckCircle2 size={12} /> {ta.upToDate}</span>
                            )}
                          </div>
                          <div className="flex items-center justify-between text-[10px] font-bold text-slate-500 dark:text-slate-400">
                            <span>{ta.serverVersion}</span>
                            <span className="font-mono">{ds?.localCommit || '—'}{ds?.behind ? ` → ${ds?.remoteCommit}` : ''}</span>
                          </div>
                          {ds?.lastFinishedAt && (
                            <div className="flex items-center justify-between text-[10px] font-bold text-slate-500 dark:text-slate-400">
                              <span>{ta.lastDeploy}</span>
                              <span className="flex items-center gap-1.5">
                                {ds.lastSuccess === false
                                  ? <span className="text-red-600 flex items-center gap-1"><AlertCircle size={11} /> {ta.deployErr}</span>
                                  : <span className="text-green-600 flex items-center gap-1"><CheckCircle2 size={11} /> {ta.deployOk}</span>}
                                <span className="text-slate-400 dark:text-slate-500">{new Date(ds.lastFinishedAt).toLocaleString()}</span>
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
                    <div className="flex items-center justify-between p-4 bg-slate-50 dark:bg-black/40 rounded-3xl border border-slate-100 dark:border-white/[0.08]">
                      <div>
                        <p className="text-[11px] font-black text-slate-900 dark:text-white uppercase tracking-widest">{ta.autoDeploy}</p>
                        <p className="text-[9px] font-bold text-slate-400 dark:text-slate-500 mt-0.5">{mode === 'auto' ? ta.autoOn : ta.autoOff}</p>
                      </div>
                      <label className="relative inline-flex items-center cursor-pointer shrink-0">
                        <input type="checkbox" className="sr-only peer" disabled={offline} checked={mode === 'auto'} onChange={e => setDeployMode(e.target.checked ? 'auto' : 'manual')} />
                        <div className="w-12 h-7 bg-slate-200 dark:bg-white/10 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-5 after:content-[''] after:absolute after:top-0.5 after:left-0.5 after:bg-white after:rounded-full after:h-6 after:w-6 after:transition-all peer-checked:bg-red-600 peer-disabled:opacity-40" />
                      </label>
                    </div>
                  </div>
                );
              })()}
            </div>

            {/* ── Database backups ────────────────────────────────────────── */}
            <div className="bg-white dark:bg-[#1c1c1e] p-5 md:p-8 rounded-[2rem] border border-slate-100 dark:border-white/[0.08] shadow-sm">
              <div className="flex items-center gap-4 mb-6">
                <div className="p-3 bg-red-50 text-red-600 rounded-2xl"><HardDrive size={24} /></div>
                <div className="flex-1">
                  <h3 className="text-sm font-black text-slate-900 dark:text-white uppercase tracking-widest">{ta.backupTitle}</h3>
                  <p className="text-[9px] font-black text-slate-400 dark:text-slate-500 uppercase tracking-widest mt-1">{ta.backupSubtitle}</p>
                </div>
                <button
                  onClick={() => setShowBackupConfig(true)}
                  className="p-2.5 bg-slate-100 dark:bg-white/[0.06] text-slate-500 dark:text-slate-400 hover:bg-red-50 dark:hover:bg-red-500/20 hover:text-red-600 rounded-xl transition-colors"
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
                    <div className="p-5 bg-slate-50 dark:bg-black/40 rounded-3xl border border-slate-100 dark:border-white/[0.08] space-y-3">
                      {offline ? (
                        <p className="text-[10px] font-bold text-slate-400 dark:text-slate-500 flex items-center gap-2">
                          <AlertCircle size={14} className="text-amber-500" /> {ta.backupAgentOffline}
                        </p>
                      ) : (
                        <>
                          <div className="flex items-center justify-between">
                            <span className="text-[9px] font-black uppercase tracking-widest text-slate-400 dark:text-slate-500">{ta.backupActiveTargets}</span>
                            <span className="text-[10px] font-black text-slate-600 dark:text-slate-300">
                              {targetSummary.length > 0 ? targetSummary.join(' · ') : ta.backupNoTargets}
                            </span>
                          </div>
                          <div className="flex items-center justify-between">
                            <span className="text-[9px] font-black uppercase tracking-widest text-slate-400 dark:text-slate-500">{ta.backupSchedule}</span>
                            <span className="text-[10px] font-black text-slate-600 dark:text-slate-300">
                              {cfg?.schedule?.enabled
                                ? `${ta.backupEvery} ${cfg.schedule.intervalHours}${ta.backupHours}`
                                : ta.backupScheduleOff}
                            </span>
                          </div>
                          {last && (
                            <div className="flex items-center justify-between">
                              <span className="text-[9px] font-black uppercase tracking-widest text-slate-400 dark:text-slate-500">{ta.backupLastRun}</span>
                              <span className="flex items-center gap-1.5 text-[10px] font-bold">
                                {last.success
                                  ? <span className="text-green-600 flex items-center gap-1"><CheckCircle2 size={11} /> {ta.deployOk}</span>
                                  : <span className="text-red-600 flex items-center gap-1"><AlertCircle size={11} /> {ta.deployErr}</span>
                                }
                                <span className="text-slate-400 dark:text-slate-500">{new Date(last.finishedAt || last.startedAt).toLocaleString()}</span>
                              </span>
                            </div>
                          )}
                          {last?.error && (
                            <p className="text-[10px] font-mono text-red-500 bg-red-50 p-2 rounded-lg break-words">{last.error}</p>
                          )}
                          {st?.lastRestore && (
                            <div className="flex items-center justify-between border-t border-slate-200 dark:border-white/10 pt-2">
                              <span className="text-[9px] font-black uppercase tracking-widest text-slate-400 dark:text-slate-500">{ta.backupLastRestore}</span>
                              <span className="text-[10px] font-bold">
                                {st.lastRestore.success === false
                                  ? <span className="text-red-600">{ta.deployErr}</span>
                                  : st.lastRestore.success
                                  ? <span className="text-green-600">{ta.deployOk}</span>
                                  : <span className="text-blue-600">…</span>
                                }
                                <span className="text-slate-400 dark:text-slate-500 ml-2">{st.lastRestore.filename}</span>
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
                            <p className="text-center text-[10px] text-slate-300 dark:text-slate-600 font-bold uppercase tracking-widest py-4">{ta.backupNoBackups}</p>
                          )}
                          {(st?.backups || []).map((b: any) => (
                            <div key={b.filename} className="flex items-center justify-between p-3 bg-slate-50 dark:bg-black/40 rounded-2xl border border-slate-100 dark:border-white/[0.08]">
                              <div className="min-w-0 flex-1">
                                <p className="text-[10px] font-mono font-bold text-slate-700 dark:text-slate-200 truncate">{b.filename}</p>
                                <p className="text-[9px] text-slate-400 dark:text-slate-500">{new Date(b.createdAt).toLocaleString()} · {formatBytes(b.sizeBytes)}</p>
                              </div>
                              <button
                                onClick={() => { setRestoreTarget(b.filename); setRestoreConfirm(''); }}
                                disabled={backupBusy}
                                className="ml-3 px-3 py-2 bg-white dark:bg-[#1c1c1e] border border-slate-200 dark:border-white/10 text-slate-500 dark:text-slate-400 hover:bg-amber-50 hover:text-amber-600 hover:border-amber-200 text-[9px] font-black uppercase tracking-widest rounded-xl transition-colors flex items-center gap-1.5 shrink-0 disabled:opacity-40"
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

            <div className="bg-white dark:bg-[#1c1c1e] p-5 md:p-8 rounded-[2rem] border border-slate-100 dark:border-white/[0.08] shadow-sm">
              <div className="flex items-center gap-4 mb-6">
                  <div className="p-3 bg-red-50 text-red-600 rounded-2xl">
                      <Database size={24} />
                  </div>
                  <div>
                      <h3 className="text-sm font-black text-slate-900 dark:text-white uppercase tracking-widest">{ta.database}</h3>
                      <p className="text-[9px] font-black text-slate-400 dark:text-slate-500 uppercase tracking-widest mt-1">{ta.backupSection}</p>
                  </div>
              </div>
              <div className="space-y-6">
                  <div className="p-5 md:p-6 bg-slate-50 dark:bg-black/40 rounded-3xl border border-slate-100 dark:border-white/[0.08]">
                      <h4 className="text-[10px] font-black text-slate-500 dark:text-slate-400 uppercase tracking-widest mb-1 flex items-center gap-2">
                          <Upload size={14} /> Server API Key
                      </h4>
                      <p className="text-[9px] text-slate-400 dark:text-slate-500 font-bold mb-3">{ta.apiKeyDesc}</p>
                      <div className="flex gap-2">
                        <input
                          type="password"
                          className="flex-1 min-w-0 bg-white dark:bg-[#1c1c1e] border border-slate-200 dark:border-white/10 rounded-2xl px-4 py-3 text-xs font-mono focus:border-red-600 outline-none"
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
                      <div className={`mb-4 px-3 py-2 rounded-xl text-[10px] font-bold flex items-center justify-between gap-2 ${thisBrowserExcluded ? 'bg-green-50 text-green-700 border border-green-100' : 'bg-amber-50 text-amber-700 border border-amber-100'}`}> <span className="flex items-center gap-1.5"> {thisBrowserExcluded ? <><CheckCircle2 size={12} /> {ta.browserExcluded}</> : <><AlertCircle size={12} /> {ta.browserNotExcluded}</>} </span> {thisBrowserExcluded && thisBrowserToken && ( <span className="font-mono text-[9px] opacity-60">{thisBrowserToken.slice(0, 8)}…</span> )} </div> <button onClick={handleExcludeSelf} className="w-full mb-4 py-3 bg-slate-900 text-white rounded-2xl text-[10px] font-black uppercase tracking-widest hover:bg-slate-800 active:scale-95 transition-all flex items-center justify-center gap-2" > <ShieldCheck size={13} /> {ta.excludeSelfBtn} </button> {/* Usernames */} <label className="text-[8px] font-black uppercase text-slate-500 dark:text-slate-400 tracking-widest ml-1">{ta.excludeUsernames}</label> <div className="flex gap-2 mt-1 mb-2"> <input className="flex-1 min-w-0 bg-white dark:bg-[#1c1c1e] border border-slate-200 dark:border-white/10 rounded-2xl px-4 py-3 text-xs font-bold focus:border-slate-500 outline-none" placeholder="@username" value={newExcludeUsername} onChange={e => setNewExcludeUsername(e.target.value)} onKeyDown={e => { if (e.key ==='Enter') handleAddExcludeUsername(); }} /> <button onClick={handleAddExcludeUsername} className="px-5 bg-slate-900 text-white rounded-2xl text-[10px] font-black uppercase tracking-widest shrink-0">{ta.add}</button> </div> <div className="flex flex-wrap gap-1.5 mb-4 min-h-[1.5rem]"> {(db.analyticsExcludes?.usernames || []).length === 0 && ( <span className="text-[9px] text-slate-300 dark:text-slate-600 font-bold uppercase tracking-widest">{ta.excludesEmpty}</span> )} {(db.analyticsExcludes?.usernames || []).map(u => ( <span key={u} className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-white dark:bg-[#1c1c1e] border border-slate-200 dark:border-white/10 rounded-lg text-[10px] font-bold text-slate-700"> @{u} <button onClick={() => handleRemoveExcludeUsername(u)} className="text-slate-300 hover:text-red-500 transition-colors"><X size={10} /></button> </span> ))} </div> {/* IPs */} <label className="text-[8px] font-black uppercase text-slate-500 tracking-widest ml-1">{ta.excludeIps}</label> <div className="flex gap-2 mt-1 mb-2"> <input className="flex-1 min-w-0 bg-white border border-slate-200 rounded-2xl px-4 py-3 text-xs font-bold focus:border-slate-500 outline-none" placeholder="1.2.3.4" value={newExcludeIp} onChange={e => setNewExcludeIp(e.target.value)} onKeyDown={e => { if (e.key ==='Enter') handleAddExcludeIp(); }} /> <button onClick={handleAddExcludeIp} className="px-5 bg-slate-900 text-white rounded-2xl text-[10px] font-black uppercase tracking-widest shrink-0">{ta.add}</button> </div> <div className="flex flex-wrap gap-1.5 mb-4 min-h-[1.5rem]"> {(db.analyticsExcludes?.ips || []).length === 0 && ( <span className="text-[9px] text-slate-300 dark:text-slate-600 font-bold uppercase tracking-widest">{ta.excludesEmpty}</span> )} {(db.analyticsExcludes?.ips || []).map(ip => ( <span key={ip} className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-white dark:bg-[#1c1c1e] border border-slate-200 dark:border-white/10 rounded-lg text-[10px] font-bold text-slate-700 font-mono"> {ip} <button onClick={() => handleRemoveExcludeIp(ip)} className="text-slate-300 hover:text-red-500 transition-colors"><X size={10} /></button> </span> ))} </div> {/* Telegram numeric user IDs — stable across username changes */} <label className="text-[8px] font-black uppercase text-slate-500 tracking-widest ml-1">{ta.excludeUserIds}</label> <div className="flex gap-2 mt-1 mb-2"> <input className="flex-1 min-w-0 bg-white border border-slate-200 rounded-2xl px-4 py-3 text-xs font-bold focus:border-slate-500 outline-none" placeholder="123456789" inputMode="numeric" value={newExcludeUserId} onChange={e => setNewExcludeUserId(e.target.value)} onKeyDown={e => { if (e.key ==='Enter') handleAddExcludeUserId(); }} /> <button onClick={handleAddExcludeUserId} className="px-5 bg-slate-900 text-white rounded-2xl text-[10px] font-black uppercase tracking-widest shrink-0">{ta.add}</button> </div> <div className="flex flex-wrap gap-1.5 mb-4 min-h-[1.5rem]"> {(db.analyticsExcludes?.userIds || []).length === 0 && ( <span className="text-[9px] text-slate-300 dark:text-slate-600 font-bold uppercase tracking-widest">{ta.excludesEmpty}</span> )} {(db.analyticsExcludes?.userIds || []).map(uid => ( <span key={uid} className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-white dark:bg-[#1c1c1e] border border-slate-200 dark:border-white/10 rounded-lg text-[10px] font-bold text-slate-700 font-mono"> {uid} <button onClick={() => handleRemoveExcludeUserId(uid)} className="text-slate-300 hover:text-red-500 transition-colors"><X size={10} /></button> </span> ))} </div> {/* Registered browsers (per-device localStorage tokens) */} <label className="text-[8px] font-black uppercase text-slate-500 tracking-widest ml-1">{ta.excludeBrowsers}</label> <p className="text-[9px] text-slate-400 mt-1 mb-2 leading-relaxed">{ta.browsersHelp}</p> <div className="flex gap-2 mb-2"> <input className="flex-1 min-w-0 bg-white border border-slate-200 rounded-2xl px-4 py-3 text-xs font-bold focus:border-slate-500 outline-none" placeholder={ta.browserLabelPh} value={browserLabel} onChange={e => setBrowserLabel(e.target.value)} onKeyDown={e => { if (e.key ==='Enter') handleRegisterBrowser(); }}
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
                                  <div key={b.token} className={`flex items-center gap-2 px-3 py-2 rounded-xl text-[10px] font-bold border ${isMe ? 'bg-green-50 border-green-100 text-green-700' : 'bg-white dark:bg-[#1c1c1e] border-slate-200 dark:border-white/10 text-slate-700 dark:text-slate-200'}`}> <span className="font-mono text-slate-400 dark:text-slate-500 shrink-0">{b.token.slice(0, 8)}…</span> <span className="flex-1 min-w-0 truncate">{b.label}</span> <span className="text-[9px] text-slate-300 shrink-0">{new Date(b.addedAt).toLocaleDateString()}</span> {isMe && <span className="text-[9px] font-black uppercase text-green-600 shrink-0">{ta.youHere}</span>} <button onClick={() => handleRemoveBrowser(b.token)} className="text-slate-300 hover:text-red-500 transition-colors shrink-0"><X size={11} /></button> </div> ); })} </div>
                      {/* Visitor pseudonyms — added from the access log. Listed
                          here so an exclude made with one tap can be undone. */}
                      {(db.analyticsExcludes?.visitors || []).length > 0 && (
                        <div className="mt-4">
                          <label className="text-[8px] font-black uppercase text-slate-500 dark:text-slate-400 tracking-widest ml-1">{ta.excludeVisitors}</label>
                          <div className="flex flex-wrap gap-1.5 mt-1">
                            {(db.analyticsExcludes?.visitors || []).map(h => (
                              <span key={h} className="inline-flex items-center gap-1.5 px-2 py-1 bg-white dark:bg-[#1c1c1e] border border-slate-200 dark:border-white/10 rounded-lg text-[10px] font-bold text-slate-700 dark:text-slate-200">
                                <span className="w-2 h-2 rounded-sm shrink-0" style={{ background: visitorTint(h) }} />
                                <span className="tracking-wider">{h.slice(0, 6)}</span>
                                <button onClick={() => handleRemoveExcludeVisitor(h)} className="text-slate-300 hover:text-red-500 transition-colors"><X size={10} /></button>
                              </span>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* Apply the list to rows recorded before it existed. */}
                      <button
                        onClick={handlePurgeExcluded}
                        disabled={purging}
                        className="w-full mt-4 py-3 bg-white dark:bg-[#1c1c1e] border border-slate-300 dark:border-white/15 text-slate-700 dark:text-slate-200 rounded-2xl text-[10px] font-black uppercase tracking-widest hover:border-red-400 hover:text-red-600 active:scale-95 transition-all flex items-center justify-center gap-2 disabled:opacity-40"
                      >
                        <Trash2 size={13} /> {ta.purgeExcludedBtn}
                      </button>
                      <p className="text-[9px] text-slate-400 dark:text-slate-500 font-bold mt-2 leading-relaxed">{ta.purgeExcludedDesc}</p>
                      </div> {/* Reset content stats */} <div className="p-5 md:p-6 bg-red-50 rounded-3xl border border-red-100"> <h4 className="text-[10px] font-black text-red-500 uppercase tracking-widest mb-3 flex items-center gap-2"> <BarChart4 size={14} /> {ta.resetStatsTitle} </h4> <p className="text-[9px] text-slate-400 font-bold mb-4">{ta.resetStatsDesc}</p> <button onClick={handleResetStats} className="w-full py-4 bg-red-600 text-white rounded-2xl text-xs font-black uppercase tracking-widest shadow-md active:scale-95 transition-all hover:bg-red-700"> {ta.resetStatsButton} </button> </div> {/* Reset traffic stats */} <div className="p-5 md:p-6 bg-red-50 rounded-3xl border border-red-100"> <h4 className="text-[10px] font-black text-red-500 uppercase tracking-widest mb-3 flex items-center gap-2"> <Monitor size={14} /> {ta.resetTrafficTitle} </h4> <p className="text-[9px] text-slate-400 font-bold mb-4">{ta.resetTrafficDesc}</p> <button onClick={handleResetTrafficStats} className="w-full py-4 bg-red-600 text-white rounded-2xl text-xs font-black uppercase tracking-widest shadow-md active:scale-95 transition-all hover:bg-red-700"> {ta.resetTrafficButton} </button> </div> {/* #36 — GDPR / right-to-erasure. Surgical, per-user delete distinct from the aggregate "reset stats" above. */} <div className="p-5 md:p-6 bg-red-50 rounded-3xl border border-red-100"> <h4 className="text-[10px] font-black text-red-500 uppercase tracking-widest mb-3 flex items-center gap-2"> <Trash2 size={14} /> {ta.eraseUserTitle} </h4> <p className="text-[9px] text-slate-400 font-bold mb-4">{ta.eraseUserDesc}</p> <input className="w-full mb-3 bg-white dark:bg-[#1c1c1e] border border-red-200 rounded-2xl px-4 py-3 text-xs font-mono focus:border-red-600 outline-none" placeholder={ta.eraseUserPlaceholder} value={eraseTarget} onChange={e => setEraseTarget(e.target.value)} /> <button onClick={handleEraseUser} disabled={!eraseTarget.trim()} className="w-full py-4 bg-red-600 text-white rounded-2xl text-xs font-black uppercase tracking-widest shadow-md active:scale-95 transition-all hover:bg-red-700 disabled:opacity-40"> {ta.eraseUserButton} </button> </div> {/* Error log (built-in monitoring) */} <div className="p-5 md:p-6 bg-slate-50 dark:bg-black/40 rounded-3xl border border-slate-200 dark:border-white/10 overflow-hidden"> <div className="flex items-center justify-between mb-1"> <h4 className="text-[10px] font-black text-slate-700 uppercase tracking-widest flex items-center gap-2"> <AlertCircle size={14} /> {ta.errorLogTitle} {errorRows.length > 0 && ( <span className="px-1.5 py-0.5 rounded-md bg-red-600 text-white text-[9px]">{errorRows.length}</span> )} </h4> <div className="flex items-center gap-1 shrink-0"> <button onClick={refreshErrors} title={ta.errorLogRefresh} className="p-2 text-slate-400 hover:text-slate-700 transition-colors"> <RefreshCw size={14} className={errorsLoading ?'animate-spin' : ''} />
                              </button>
                              {errorRows.length > 0 && (
                                  <button onClick={handleClearErrors} title={ta.errorLogClear} className="p-2 text-slate-400 hover:text-red-600 transition-colors">
                                      <Trash2 size={14} />
                                  </button>
                              )}
                          </div>
                      </div>
                      <p className="text-[9px] text-slate-400 font-bold mb-4">{ta.errorLogDesc}</p>

                      {errorRows.length === 0 ? (
                          <div className="py-6 text-center">
                              <CheckCircle2 size={20} className="text-green-500 mx-auto mb-2" />
                              <p className="text-[10px] text-slate-400 font-bold uppercase tracking-widest">{ta.errorLogEmpty}</p>
                          </div>
                      ) : (
                          <div className="space-y-2 max-h-80 overflow-y-auto">
                              {errorRows.map(e => (
                                  <div key={e.id} className="bg-white rounded-2xl border border-slate-100 overflow-hidden">
                                      <button
                                          onClick={() => setExpandedError(expandedError === e.id ? null : e.id)}
                                          className="w-full text-left p-3 flex items-start gap-2"
                                      >
                                          <span className={`mt-0.5 px-1.5 py-0.5 rounded text-[8px] font-black uppercase shrink-0 ${e.source === 'server' ? 'bg-purple-100 text-purple-700' : 'bg-amber-100 text-amber-700'}`}>
                                              {e.source}
                                          </span>
                                          <div className="min-w-0 flex-1">
                                              <p className="text-[11px] font-bold text-slate-800 break-words line-clamp-2">{e.message}</p>
                                              <p className="text-[8px] text-slate-400 mt-1 truncate">
                                                  {new Date(e.ts).toLocaleString()}
                                                  {e.kind ? ` · ${e.kind}` : ''}
                                                  {e.username ? ` · @${e.username}` : ''} </p> </div> </button> {expandedError === e.id && ( <div className="px-3 pb-3 space-y-2 border-t border-slate-100 dark:border-white/[0.08] pt-2"> {e.url && <p className="text-[9px] text-slate-500 dark:text-slate-400 break-all"><b>URL:</b> {e.url}</p>} {e.user_agent && <p className="text-[9px] text-slate-400 break-all">{e.user_agent}</p>} {e.stack && ( <pre className="text-[8px] text-slate-600 bg-slate-50 dark:bg-black/40 rounded-lg p-2 overflow-x-auto whitespace-pre-wrap break-words max-h-48">{e.stack}</pre> )} </div> )} </div> ))} </div> )} </div> {/* Export */} <div className="p-5 md:p-6 bg-amber-50 rounded-3xl border border-amber-200"> <h4 className="text-[10px] font-black text-amber-700 uppercase tracking-widest mb-1 flex items-center gap-2"> <Database size={14} /> {ta.exportTitle} </h4> <p className="text-[9px] text-amber-600 font-bold mb-4"> {ta.exportDesc} </p> <label className="text-[8px] font-black uppercase text-amber-700 tracking-widest ml-1"> {ta.exportConfirmLabel} </label> <div className="flex gap-2 mt-1"> <input className="flex-1 min-w-0 bg-white border border-amber-200 rounded-2xl px-4 py-3 text-xs font-bold focus:border-amber-500 outline-none" placeholder={ta.exportWord} value={exportConfirm} onChange={e => setExportConfirm(e.target.value)} /> <button onClick={handleExportJson} disabled={exportConfirm !== ta.exportWord} className="px-5 bg-amber-600 text-white rounded-2xl text-[10px] font-black uppercase tracking-widest disabled:opacity-40 transition-all active:scale-95" > {ta.exportButton} </button> </div> </div> {/* Import */} <div className="p-5 md:p-6 bg-red-50 rounded-3xl border border-red-200"> <h4 className="text-[10px] font-black text-red-700 uppercase tracking-widest mb-1 flex items-center gap-2"> <Upload size={14} /> {ta.importTitle} </h4> <p className="text-[9px] text-red-600 font-bold mb-4"> {ta.importDesc} </p> <textarea className="w-full h-28 bg-white border border-red-200 rounded-2xl p-4 text-[10px] font-mono mb-3 focus:border-red-600 outline-none" placeholder={ta.importPlaceholder} value={importJson} onChange={e => setImportJson(e.target.value)} /> <label className="text-[8px] font-black uppercase text-red-700 tracking-widest ml-1"> {ta.importConfirmLabel} </label> <div className="flex gap-2 mt-1"> <input className="flex-1 min-w-0 bg-white border border-red-200 rounded-2xl px-4 py-3 text-xs font-bold focus:border-red-600 outline-none" placeholder={ta.rewriteWord} value={importConfirm} onChange={e => setImportConfirm(e.target.value)} /> <button onClick={handleImportJson} disabled={importConfirm !== ta.rewriteWord || !importJson.trim()} className="px-5 bg-red-700 text-white rounded-2xl text-[10px] font-black uppercase tracking-widest disabled:opacity-40 transition-all active:scale-95" > {ta.importButton} </button> </div> </div> </div> </div> </div> )} {activeTab ==='items' && (
           <div className="space-y-6">
               <button 
                  onClick={() => setEditingItem({ id: Date.now().toString(), type: db.customTypes[0]?.id || 'BOOK', isPrivate: false, formats: [], title: {en:'',ru:'',es:''}, description: {en:'',ru:'',es:''}, author: '', publishedDate: new Date().toISOString().split('T')[0], contentLanguages: ['en'], allowDownload: true, allowReading: true })} className="w-full py-4 bg-red-600 text-white rounded-[2rem] font-black uppercase tracking-[0.3em] text-xs shadow-xl shadow-red-200 flex items-center justify-center gap-2" > <Plus size={18} /> {t.addContent} </button>

              {/* Search + type filter — with hundreds of items the unfiltered
                  list was a haystack. Search scans the localized title plus
                  the primary/secondary authors; the type chip row narrows
                  by content kind. Both compose with the visible row count
                  shown next to the type label. */}
              <div className="space-y-3">
                <div className="relative">
                  <SearchIcon className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" size={15} aria-hidden="true" />
                  <input
                    type="text"
                    value={adminItemSearch}
                    onChange={(e) => setAdminItemSearch(e.target.value)}
                    placeholder={ta.itemSearchPh}
                    className="w-full bg-white dark:bg-[#1c1c1e] border border-slate-200 dark:border-white/[0.08] rounded-2xl py-3 pl-11 pr-10 text-xs font-bold focus:outline-none focus:border-red-500 transition-colors"
                  />
                  {adminItemSearch && (
                    <button
                      onClick={() => setAdminItemSearch('')}
                      className="absolute right-3 top-1/2 -translate-y-1/2 p-1 rounded-md text-slate-400 hover:text-red-600 hover:bg-slate-100 dark:hover:bg-white/10"
                      aria-label={t.clearSearch || 'Clear'}
                    >
                      <X size={13} strokeWidth={2.5} />
                    </button>
                  )}
                </div>
                <div className="flex gap-2 overflow-x-auto no-scrollbar pb-1">
                  <button
                    onClick={() => setAdminItemTypeFilter('ALL')}
                    className={`shrink-0 px-4 h-8 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all ${adminItemTypeFilter === 'ALL' ? 'bg-red-600 text-white' : 'bg-white dark:bg-[#1c1c1e] text-slate-500 border border-slate-200 dark:border-white/[0.08]'}`}
                  >
                    {t.all} · {db.items.length}
                  </button>
                  {db.customTypes.map(tp => {
                    const n = db.items.filter(it => it.type === tp.id).length;
                    if (n === 0) return null;
                    const active = adminItemTypeFilter === tp.id;
                    return (
                      <button
                        key={tp.id}
                        onClick={() => setAdminItemTypeFilter(tp.id)}
                        className={`shrink-0 px-4 h-8 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all ${active ? 'bg-red-600 text-white' : 'bg-white dark:bg-[#1c1c1e] text-slate-500 border border-slate-200 dark:border-white/[0.08]'}`}
                      >
                        {tp[lang] || tp.en || tp.id} · {n}
                      </button>
                    );
                  })}
                </div>
                {/* Hosting filter — for licence audits: what do we serve vs
                    merely link to. Amber matches the "external" cue elsewhere. */}
                <div className="flex gap-2 overflow-x-auto no-scrollbar pb-1 mt-2">
                  {([
                    { key: 'ALL' as const,      label: ta.sourceFilterAll,      count: db.items.length },
                    { key: 'LOCAL' as const,    label: ta.sourceFilterLocal,    count: db.items.filter(i => !isExternallyHosted(i)).length },
                    { key: 'EXTERNAL' as const, label: ta.sourceFilterExternal, count: db.items.filter(i => isExternallyHosted(i)).length },
                  ]).map(({ key, label, count }) => {
                    const active = adminItemSourceFilter === key;
                    return (
                      <button
                        key={key}
                        onClick={() => setAdminItemSourceFilter(key)}
                        className={`shrink-0 px-4 h-8 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all ${
                          active
                            ? (key === 'EXTERNAL' ? 'bg-amber-500 text-white' : 'bg-slate-900 dark:bg-white text-white dark:text-slate-900')
                            : 'bg-white dark:bg-[#1c1c1e] text-slate-500 border border-slate-200 dark:border-white/[0.08]'
                        }`}
                      >
                        {label} · {count}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="space-y-3">
                {adminFilteredItems.length === 0 && (
                  <p className="text-center py-12 text-[10px] font-black uppercase text-slate-300 dark:text-slate-600 tracking-widest">{t.noResults || 'No results'}</p>
                )}
                {adminFilteredItems.map((i, idx) => {
                const idx8 = itemIndexState(i);
                return (
                  <div key={i.id} className="bg-white p-4 rounded-[2rem] border border-slate-100 dark:border-white/[0.08] flex items-center justify-between shadow-sm flex-wrap gap-y-2">
                    <div className="flex items-center gap-3 overflow-hidden min-w-0">
                      <span className="text-[10px] font-black text-slate-300 dark:text-slate-600 tabular-nums w-7 text-right shrink-0">{idx + 1}.</span>
                      <button
                        type="button"
                        onClick={() => onPreviewItem(i)}
                        title={ta.previewItem}
                        aria-label={ta.previewItem}
                        className="relative w-12 h-12 rounded-xl overflow-hidden bg-slate-50 dark:bg-black/40 shrink-0 group cursor-pointer focus:outline-none focus:ring-2 focus:ring-red-500"
                      >
                        <CardCover item={i} lang={lang} />
                        {/* Hover scrim + magnifier hint that the cover opens the content. */}
                        <span className="absolute inset-0 flex items-center justify-center bg-black/0 group-hover:bg-black/45 transition-colors">
                          <Eye size={16} className="text-white opacity-0 group-hover:opacity-100 transition-opacity" />
                        </span>
                      </button>
                      <div className="min-w-0">
                        <h4 className="text-xs font-black text-slate-900 dark:text-white truncate">{pickText(i.title, lang)}</h4>
                        <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                          <span className="text-[8px] font-black text-slate-400 dark:text-slate-500 uppercase tracking-widest">{i.type}</span>
                          {i.addedDate && (
                            <span className="text-[8px] font-bold text-slate-300 dark:text-slate-600 tabular-nums">
                              {new Date(i.addedDate).toLocaleDateString(lang === 'en' ? 'en-US' : lang === 'es' ? 'es-ES' : 'ru-RU', { day: '2-digit', month: 'short', year: 'numeric' })}
                            </span>
                          )}
                          {/* Whether this material is searchable — visible only here,
                              inside the admin, and only after the report has loaded. */}
                          {(() => {
                            const st = idx8;
                            const styles = {
                              ok:      'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-400 dark:border-emerald-500/25',
                              partial: 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-500/10 dark:text-amber-400 dark:border-amber-500/25',
                              missing: 'bg-slate-100 text-slate-500 border-slate-200 dark:bg-white/5 dark:text-slate-400 dark:border-white/10',
                              needsSubtitles: 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-500/10 dark:text-amber-400 dark:border-amber-500/25',
                              failed:  'bg-red-50 text-red-700 border-red-200 dark:bg-red-500/10 dark:text-red-400 dark:border-red-500/25',
                              none:    'bg-slate-100 text-slate-400 border-slate-200 dark:bg-white/5 dark:text-slate-500 dark:border-white/10',
                            } as const;
                            const text =
                              st.kind === 'ok'      ? `${ta.scan.indexStateIndexed} · ${st.chunks.toLocaleString(lang === 'ru' ? 'ru-RU' : lang)} ${ta.scan.indexChunks}`
                            : st.kind === 'partial' ? `${ta.scan.cardPartial} ${st.done}/${st.total}`
                            : st.kind === 'failed'  ? ta.scan.indexStateFailed
                            : st.kind === 'needsSubtitles' ? ta.scan.cardNeedsSubtitles
                            : st.kind === 'none'    ? ta.scan.cardNothing
                            : ta.scan.cardNotIndexed;
                            return (
                              <span className={`px-2 py-0.5 rounded-lg border text-[8px] font-black uppercase tracking-widest ${styles[st.kind]}`}>
                                {text}
                              </span>
                            );
                          })()}
                          {idx8.kind === 'ok' && idx8.manual > 0 && (
                            <span className="px-2 py-0.5 rounded-lg bg-red-50 dark:bg-red-500/10 text-red-600 text-[8px] font-black uppercase tracking-widest">
                              {idx8.manual} {ta.scan.indexManual}
                            </span>
                          )}
                        </div>
                        {idx8.kind === 'failed' && idx8.detail && (
                          <p className="text-[8px] font-bold text-red-500 mt-1 break-words">{idx8.detail}</p>
                        )}
                      </div>
                    </div>
                    <div className="flex gap-2 shrink-0">
                      {idx8.canIndexDocuments && (
                        <button
                          onClick={() => handleIndexRun(i.id)}
                          disabled={indexReport?.job?.running}
                          title={ta.scan.cardReindex}
                          aria-label={ta.scan.cardReindex}
                          className="p-2 bg-slate-50 dark:bg-white/[0.06] rounded-xl hover:bg-red-50 dark:hover:bg-red-500/20 hover:text-red-600 disabled:opacity-40 transition-colors"
                        >
                          <RefreshCw size={16} className={indexReport?.job?.running ? 'animate-spin' : ''} />
                        </button>
                      )}
                      {idx8.canImportSubtitles && (
                        <button
                          onClick={() => handleQueueSubtitles(i.id)}
                          title={ta.scan.queueSubtitles}
                          aria-label={ta.scan.queueSubtitles}
                          className="p-2 bg-slate-50 dark:bg-white/[0.06] rounded-xl hover:bg-red-50 dark:hover:bg-red-500/20 hover:text-red-600 transition-colors"
                        >
                          <Video size={16} />
                        </button>
                      )}
                      <button onClick={() => setEditingItem(i)} className="p-2 bg-slate-50 rounded-xl hover:bg-red-50 dark:hover:bg-red-500/20 hover:text-red-600"><Edit2 size={16}/></button>
                      <button onClick={() => setItemToDelete(i)} className="p-2 bg-slate-50 rounded-xl hover:bg-red-50 hover:text-red-600" aria-label={ta.deleteItem}><Trash2 size={16}/></button>
                    </div>
                  </div>
                );
                })}
              </div>
            </div> )} {activeTab ==='types'&& ( <div className="bg-white p-5 md:p-8 rounded-[2rem] border border-slate-100 dark:border-white/[0.08] shadow-sm"> <h3 className="text-xs md:text-sm font-black mb-6 flex items-center gap-3 text-slate-900 dark:text-white uppercase tracking-widest underline decoration-red-600 decoration-4 underline-offset-8">{t.types}</h3> {/* Add new category */} <div className="p-4 bg-slate-50 dark:bg-black/40 rounded-2xl border border-slate-100 mb-6 space-y-3"> <p className="text-[8px] font-black uppercase text-red-600 tracking-widest">{t.addCategory}</p> <div className="grid grid-cols-3 gap-2"> {(['ru', 'en', 'es'] as const).map(l => ( <div key={l}> <label className="text-[8px] font-black uppercase text-slate-400 dark:text-slate-500 ml-1">{l.toUpperCase()}</label> <input type="text" className="w-full bg-white dark:bg-[#1c1c1e] border border-slate-100 dark:border-white/[0.08] rounded-xl px-3 py-2 text-xs font-bold focus:border-red-600 outline-none" value={newTypeLabels[l]} onChange={e => { const val = e.target.value; typedLangsRef.current.add(l); setNewTypeLabels(prev => { const next = { ...prev, [l]: val }; (['en', 'ru', 'es'] as const).forEach(other => {
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
                      {(['ru', 'en', 'es'] as const).map(l => ( <div key={l}> <label className="text-[8px] font-black uppercase text-slate-400 dark:text-slate-500 ml-1">{l.toUpperCase()}</label> <input type="text" className="w-full bg-white dark:bg-[#1c1c1e] border border-red-200 rounded-xl px-3 py-2 text-xs font-bold focus:border-red-600 outline-none" value={editingType[l]} onChange={e => setEditingType({ ...editingType, [l]: e.target.value })} /> </div> ))} </div> <div className="flex gap-2"> <button onClick={handleSaveType} className="flex-1 bg-red-600 text-white py-2 rounded-xl font-black uppercase text-[10px] tracking-widest">{ta.save}</button> <button onClick={() => setEditingType(null)} className="px-5 py-2 bg-slate-100 text-slate-500 rounded-xl font-black uppercase text-[10px]">{ta.cancel}</button> </div> </div> ) : ( <div key={type.id} className="flex justify-between items-center p-3 bg-slate-50 rounded-2xl border border-slate-100"> <div className="min-w-0"> <span className="text-[10px] font-black uppercase text-slate-900">{type[lang] || type.ru || type.en || type.id}</span> <span className="text-[8px] text-slate-300 ml-2">{[type.ru, type.en, type.es].filter(Boolean).join(' · ')}</span> </div> <div className="flex gap-1 shrink-0 ml-2"> <button onClick={() => setEditingType(type)} className="p-1.5 text-slate-300 dark:text-slate-600 hover:text-blue-500 transition-colors"><Edit2 size={13} /></button> <button onClick={() => handleDeleteType(type.id)} className="p-1.5 text-slate-300 hover:text-red-600 transition-colors"><Trash2 size={13} /></button> </div> </div> ) ))} </div> </div> )} </div> {editingItem && ( <div className="fixed inset-0 z-[200] bg-slate-900/40 backdrop-blur-xl flex items-end md:items-center justify-center p-0 md:p-5 animate-in fade-in duration-200"> <div className="bg-white w-full md:max-w-3xl rounded-t-[2rem] md:rounded-[3.5rem] border border-white shadow-2xl overflow-hidden h-[90vh] md:max-h-[90vh] flex flex-col"> <div className="p-5 border-b border-slate-50 flex justify-between items-center bg-white dark:bg-[#1c1c1e] sticky top-0 z-10 shrink-0"> <h3 className="font-black text-xl uppercase tracking-tighter">{editingItem.id ?'Edit' : 'New'} Asset</h3> <button onClick={() => setEditingItem(null)} className="p-2 bg-slate-50 dark:bg-black/40 rounded-full hover:bg-red-50 dark:hover:bg-red-500/20 hover:text-red-600"><X size={20}/></button> </div> <div className="p-5 overflow-y-auto space-y-8 flex-1 no-scrollbar">
                  {/* ── 1 · Основное ────────────────────────────────────── */}
                  <EditorGroup n={1} title={ta.groupBasics} open={!!openGroups.groupBasics} onToggle={() => toggleGroup('groupBasics')}>
                    <div> <p className="text-[8px] font-black uppercase text-red-600 tracking-widest mb-3">{ta.basics}</p> <div className="space-y-3"> <div className="flex gap-3"> <div className="flex-1"> <label className="text-[8px] font-black uppercase text-slate-400 dark:text-slate-500 ml-2">{ta.typeLabel}</label> <select className="w-full bg-white dark:bg-black/30 border border-slate-300 dark:border-white/15 rounded-2xl px-4 py-3 text-xs font-bold focus:border-red-600 outline-none hover:border-red-400 dark:hover:border-red-500/50 dark:focus:border-red-500 transition-colors" value={editingItem.type ||''} onChange={e => setEditingItem({...editingItem, type: e.target.value})}> {db.customTypes.map(tp => <option key={tp.id} value={tp.id}>{tp[lang] || tp.ru || tp.en}</option>)} </select> </div> <div className="flex-1"> <AuthorsEditor label={ta.authorLabel} placeholder={ta.authorPlaceholder} authors={editingItem.authors && editingItem.authors.length ? editingItem.authors : (editingItem.author ? [editingItem.author] : [])} onChange={(authors) => setEditingItem({ ...editingItem, authors, author: authors[0] || '' })} /> </div> </div> <div className="flex flex-col sm:flex-row gap-3"> <div className="flex-1"> <div className="flex items-center justify-between ml-2 mb-1"> <label className="text-[8px] font-black uppercase text-slate-400">{ta.pubDate}</label> <div className="flex gap-0.5 bg-slate-100 dark:bg-white/[0.06] rounded-lg p-0.5"> <button type="button" onClick={() => { setPubDateMode('date');
                              const v = editingItem.publishedDate || '';
                              const next = /^\d{4}$/.test(v) ? `${v}-01-01` : (v || new Date().toISOString().split('T')[0]);
                              setEditingItem({ ...editingItem, publishedDate: next });
                            }}
                            className={`px-2 py-1 rounded-md text-[8px] font-black uppercase tracking-wider transition-colors ${pubDateMode === 'date' ? 'bg-white dark:bg-[#1c1c1e] text-red-600 shadow-sm' : 'text-slate-400 dark:text-slate-500'}`}>
                            {ta.pubModeDate}
                          </button>
                          <button type="button"
                            onClick={() => {
                              setPubDateMode('year');
                              const v = editingItem.publishedDate || '';
                              const next = v.match(/^(\d{4})/)?.[1] || String(new Date().getFullYear());
                              setEditingItem({ ...editingItem, publishedDate: next });
                            }}
                            className={`px-2 py-1 rounded-md text-[8px] font-black uppercase tracking-wider transition-colors ${pubDateMode === 'year' ? 'bg-white dark:bg-[#1c1c1e] text-red-600 shadow-sm' : 'text-slate-400 dark:text-slate-500'}`}>
                            {ta.pubModeYear}
                          </button>
                        </div>
                      </div>
                      {pubDateMode === 'year'? ( <input type="number" min="1000" max="2100" step="1" placeholder="2021" className="w-full bg-white dark:bg-black/30 border border-slate-300 dark:border-white/15 rounded-2xl px-4 py-3 text-xs font-bold focus:border-red-600 outline-none hover:border-red-400 dark:hover:border-red-500/50 dark:focus:border-red-500 transition-colors" value={editingItem.publishedDate ||''} onChange={e => setEditingItem({ ...editingItem, publishedDate: e.target.value })} /> ) : ( <input type="date" className="w-full bg-white dark:bg-black/30 border border-slate-300 dark:border-white/15 rounded-2xl px-4 py-3 text-xs font-bold focus:border-red-600 outline-none hover:border-red-400 dark:hover:border-red-500/50 dark:focus:border-red-500 transition-colors" value={editingItem.publishedDate ||''} onChange={e => setEditingItem({ ...editingItem, publishedDate: e.target.value })} /> )} </div> <div className="flex-1"> <label className="text-[8px] font-black uppercase text-slate-400 dark:text-slate-500 ml-2">{ta.editorialRating}</label> <input type="number" min="0" max="5" step="0.1" className="w-full bg-white dark:bg-black/30 border border-slate-300 dark:border-white/15 rounded-2xl px-4 py-3 text-xs font-bold focus:border-red-600 outline-none hover:border-red-400 dark:hover:border-red-500/50 dark:focus:border-red-500 transition-colors" value={editingItem.rating ?? 0} onChange={e => setEditingItem({...editingItem, rating: parseFloat(e.target.value) || 0})} /> </div> </div> </div> </div>

                    <div> <p className="text-[8px] font-black uppercase text-red-600 tracking-widest mb-3">{ta.headings}</p> <div className="space-y-3"> {(['ru', 'en', 'es'] as const).map(l => ( <div key={l}> <label className="text-[8px] font-black uppercase text-slate-400 dark:text-slate-500 ml-2">{l} {ta.heading}</label> <input type="text" className="w-full bg-white dark:bg-black/30 border border-slate-300 dark:border-white/15 rounded-2xl px-4 py-3 text-xs font-bold focus:border-red-600 outline-none hover:border-red-400 dark:hover:border-red-500/50 dark:focus:border-red-500 transition-colors" value={editingItem.title?.[l] ||''}
                        onChange={e => setEditingItem({...editingItem, title: {...editingItem.title!, [l]: e.target.value}})} />
                    </div>
                  ))}
                </div>
              </div>
                  </EditorGroup>

                  {/* ── 2 · Контент ─────────────────────────────────────── */}
                  <EditorGroup n={2} title={ta.groupContent} open={!!openGroups.groupContent} onToggle={() => toggleGroup('groupContent')}>
                    <div> <p className="text-[8px] font-black uppercase text-red-600 tracking-widest mb-3">{ta.media}</p> <div className="space-y-3"> <div> <label className="text-[8px] font-black uppercase text-slate-400 dark:text-slate-500 ml-2">{ta.cover}</label> <div className="flex gap-2"> <input type="text" placeholder="https://..." className="flex-1 bg-white dark:bg-black/30 border border-slate-300 dark:border-white/15 rounded-2xl px-4 py-3 text-xs font-bold focus:border-red-600 outline-none hover:border-red-400 dark:hover:border-red-500/50 dark:focus:border-red-500 transition-colors" value={editingItem.coverUrl ||''} onChange={e => setEditingItem({...editingItem, coverUrl: e.target.value})} />
                      <button type="button"
                        onClick={() => coverInputRef.current?.click()}
                        disabled={uploadState?.field === 'cover'|| !!stagedCoverFile} title={ta.chooseFile} className="px-3 bg-slate-100 dark:bg-white/[0.06] rounded-2xl text-slate-500 dark:text-slate-400 hover:bg-red-50 dark:hover:bg-red-500/20 hover:text-red-600 transition-colors disabled:opacity-40 shrink-0"> <Upload size={16} /> </button> </div> {stagedCoverFile && !uploadState && ( <div className="mt-2 flex items-center gap-2 p-2 bg-blue-50 rounded-xl border border-blue-100"> <span className="text-[9px] font-bold text-blue-700 flex-1 truncate">{stagedCoverFile.name} ({formatFileSize(stagedCoverFile.size)})</span> <button type="button" onClick={() => editingItem?.id && uploadCover(editingItem.id)} className="px-3 py-1 bg-blue-600 text-white text-[9px] font-black rounded-lg shrink-0">{ta.uploadBtn}</button> <button type="button" onClick={() => { setStagedCoverFile(null); if (coverInputRef.current) coverInputRef.current.value =''; }} className="p-1 text-blue-400 hover:text-red-500 shrink-0"><X size={12} /></button>
                      </div>
                    )}
                    {uploadState?.field === 'cover' && (
                      <div className="mt-2 bg-slate-100 rounded-full h-2 overflow-hidden">
                        <div className="bg-red-600 h-2 rounded-full transition-all duration-300" style={{ width: `${uploadState.progress}%` }} />
                      </div>
                    )}
                    <input ref={coverInputRef} type="file" accept="image/jpeg,image/png,image/webp" className="bg-white dark:bg-black/30 hidden border border-slate-300 dark:border-white/15 focus:border-red-600 hover:border-red-400 dark:hover:border-red-500/50 dark:focus:border-red-500 transition-colors"
                      onChange={e => setStagedCoverFile(e.target.files?.[0] || null)} />
                  </div>
                  <div>
                    <div className="flex items-center justify-between mb-2">
                      <label className="text-[8px] font-black uppercase text-slate-400 ml-2 flex items-center gap-1.5"><Video size={11} /> {ta.videoContent}</label>
                      <button type="button" onClick={handleAddVideo} className="text-[9px] font-black uppercase bg-red-50 text-red-600 px-3 py-1.5 rounded-xl border border-red-100 hover:bg-red-100 transition-colors">{ta.addVideo}</button>
                    </div>
                    <div className="space-y-2">
                      {(editingItem.videos || []).map(v => {
                        const presets = ['YouTube', 'RuTube', 'Twitch', 'VK']; const isCustom = !presets.includes(v.source); return ( <div key={v.id} className="relative p-2.5 pl-9 bg-slate-50 dark:bg-black/40 rounded-2xl border border-slate-100 dark:border-white/[0.08] space-y-2"> <button type="button" onClick={() => handleRemoveVideo(v.id)} className="absolute top-2.5 left-2 p-1 text-slate-300 dark:text-slate-600 hover:text-red-500"><X size={14} /></button> <div className="flex flex-wrap items-center gap-2"> <div className="relative"> <select value={isCustom ?'__custom__' : v.source}
                                  onChange={e => handleUpdateVideo(v.id, 'source', e.target.value === '__custom__' ? '': e.target.value)} className="appearance-none bg-white dark:bg-[#1c1c1e] border border-slate-200 dark:border-white/10 rounded-xl pl-3 pr-8 py-2 text-[11px] font-bold focus:border-red-600 outline-none"> {presets.map(p => <option key={p} value={p}>{p}</option>)} <option value="__custom__">{ta.customSource}</option> </select> <ChevronDown size={14} className="absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none text-slate-400" /> </div> <div className="relative"> <select value={v.language ||'ru'}
                                  onChange={e => handleUpdateVideo(v.id, 'language', e.target.value)} className="appearance-none bg-white dark:bg-[#1c1c1e] border border-slate-200 dark:border-white/10 rounded-xl pl-3 pr-8 py-2 text-[11px] font-bold focus:border-red-600 outline-none"> <option value="ru">RU</option> <option value="en">EN</option> <option value="es">ES</option> <option value="it">IT</option> <option value="fr">FR</option> <option value="de">DE</option> </select> <ChevronDown size={14} className="absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none text-slate-400" /> </div> {isCustom && ( <input type="text" placeholder={ta.sourceName} className="flex-1 dark:bg-black/30 min-w-0 bg-white border border-slate-300 rounded-xl px-3 py-2 text-[11px] font-bold focus:border-red-600 outline-none dark:border-white/15 hover:border-red-400 dark:hover:border-red-500/50 dark:focus:border-red-500 transition-colors" value={v.source} onChange={e => handleUpdateVideo(v.id,'source', e.target.value)} /> )} </div> <input type="text" placeholder="https://youtube.com/watch?v=..." className="w-full bg-white dark:bg-black/30 border border-slate-300 dark:border-white/15 rounded-xl px-3 py-2 text-[11px] font-bold focus:border-red-600 outline-none hover:border-red-400 dark:hover:border-red-500/50 dark:focus:border-red-500 transition-colors" value={v.url} onChange={e => handleUpdateVideo(v.id,'url', e.target.value)} /> </div> ); })} {(!editingItem.videos || editingItem.videos.length === 0) && ( <p className="text-[9px] text-slate-300 dark:text-slate-600 font-bold uppercase tracking-widest text-center py-3">{ta.noVideo}</p> )} </div> </div> </div> </div>

                    <div className="border-t border-slate-100 pt-6">
                <div className="flex justify-between items-center mb-4">
                  <p className="text-[8px] font-black uppercase text-red-600 tracking-widest">{ta.files}</p>
                  <button onClick={handleAddFormat} className="text-[9px] font-black uppercase bg-red-50 text-red-600 px-3 py-1.5 rounded-xl border border-red-100 hover:bg-red-100 transition-colors">{ta.addFile}</button>
                </div>
                <div className="space-y-3">
                  {editingItem.formats && editingItem.formats.map((f) => {
                  // The index row for this exact file, so the state is answered
                  // where the file is edited rather than only in the list.
                  const fileIndex = (indexReport?.rows || []).find(
                    r => r.item_id === editingItem.id && r.format_url === (f.url || '').trim(),
                  );
                  return (
                    <div key={f.id} className="relative p-3 pl-9 bg-slate-50 rounded-2xl border border-slate-100">
                      <button
                        type="button"
                        onClick={() => { if (!f.url) handleRemoveFormat(f.id); }}
                        disabled={!!f.url}
                        title={f.url ? ta.fileUploadedHint : ta.removeBlock}
                        className={`absolute top-3 left-2 p-1 ${f.url ? 'text-slate-200 cursor-not-allowed' : 'text-slate-300 dark:text-slate-600 hover:text-red-500'}`}> <X size={14} /> </button>
                      {f.url && (
                        <div className="flex flex-wrap items-center gap-2 mb-2">
                          <span className={`px-2 py-0.5 rounded-lg border text-[8px] font-black uppercase tracking-widest
                            ${!fileIndex
                              ? 'bg-slate-100 text-slate-500 border-slate-200 dark:bg-white/5 dark:text-slate-400 dark:border-white/10'
                              : fileIndex.state === 'indexed'
                                ? 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-400 dark:border-emerald-500/25'
                                : fileIndex.state === 'failed'
                                  ? 'bg-red-50 text-red-700 border-red-200 dark:bg-red-500/10 dark:text-red-400 dark:border-red-500/25'
                                  : 'bg-slate-100 text-slate-500 border-slate-200 dark:bg-white/5 dark:text-slate-400 dark:border-white/10'}`}>
                            {!fileIndex ? ta.scan.cardNotIndexed
                              : fileIndex.state === 'indexed' ? ta.scan.indexStateIndexed
                              : fileIndex.state === 'failed' ? ta.scan.indexStateFailed
                              : ta.scan.indexStateSkipped}
                          </span>
                          {fileIndex?.state === 'indexed' && (
                            <span className="text-[8px] font-black uppercase tracking-widest text-slate-400 dark:text-slate-500 tabular-nums">
                              {fileIndex.pages || 0} {ta.scan.pages} · {fileIndex.chunk_count || 0} {ta.scan.indexChunks}
                              {fileIndex.quality !== null && ` · ${ta.scan.indexQuality} ${fileIndex.quality.toFixed(2)}`}
                            </span>
                          )}
                          <button
                            type="button"
                            onClick={() => handleIndexRun(editingItem.id)}
                            disabled={indexReport?.job?.running}
                            className="ml-auto px-3 py-1.5 rounded-xl bg-white dark:bg-white/[0.06] border border-slate-200 dark:border-white/10 text-[9px] font-black uppercase tracking-widest text-slate-500 dark:text-slate-300 hover:border-red-300 hover:text-red-600 disabled:opacity-40 transition-colors"
                          >
                            {ta.scan.cardReindex}
                          </button>
                          {fileIndex?.detail && (
                            <p className={`w-full text-[8px] font-bold leading-snug break-words ${fileIndex.state === 'failed' ? 'text-red-500' : 'text-slate-400 dark:text-slate-500'}`}>
                              {fileIndex.detail}
                            </p>
                          )}
                        </div>
                      )} <div className="grid grid-cols-2 gap-2"> <div> <label className="text-[7px] font-black uppercase text-slate-400 dark:text-slate-500 ml-1">{ta.nameLabel}</label> <input placeholder="PDF / EPUB / …" className="w-full bg-white dark:bg-black/30 border border-slate-300 dark:border-white/15 rounded-lg px-2 py-1.5 text-[9px] font-bold outline-none focus:border-red-600 hover:border-red-400 dark:hover:border-red-500/50 dark:focus:border-red-500 transition-colors" value={f.name} onChange={e => handleUpdateFormat(f.id,'name', e.target.value)} /> </div> <div> <label className="text-[7px] font-black uppercase text-slate-400 dark:text-slate-500 ml-1">{ta.langLabel}</label> <select className="w-full bg-white dark:bg-black/30 border border-slate-300 dark:border-white/15 rounded-lg px-2 py-1.5 text-[9px] font-bold outline-none focus:border-red-600 hover:border-red-400 dark:hover:border-red-500/50 dark:focus:border-red-500 transition-colors" value={f.language ||'ru'} onChange={e => handleUpdateFormat(f.id, 'language', e.target.value as any)}> <option value="ru">RU</option> <option value="en">EN</option> <option value="es">ES</option> <option value="it">IT</option> <option value="fr">FR</option> <option value="de">DE</option> </select> </div> <div className="col-span-2"> <label className="text-[7px] font-black uppercase text-slate-400 dark:text-slate-500 ml-1">{ta.fileUrl}</label> <div className="flex gap-1"> <input placeholder="https://..." className="flex-1 min-w-0 bg-white dark:bg-black/30 border border-slate-300 dark:border-white/15 rounded-lg px-2 py-1.5 text-[9px] font-bold outline-none focus:border-red-600 hover:border-red-400 dark:hover:border-red-500/50 dark:focus:border-red-500 transition-colors" value={f.url} onChange={e => handleUpdateFormatUrl(f.id, e.target.value)} /> <button type="button" onClick={() => { uploadingFormatId.current = f.id; fileInputRef.current?.click(); }} disabled={uploadState !== null || !!stagedContentFile || !!f.external} title={ta.chooseFile} className="px-2 bg-slate-100 dark:bg-white/[0.06] rounded-lg text-slate-500 dark:text-slate-400 hover:bg-red-50 dark:hover:bg-red-500/20 hover:text-red-600 transition-colors disabled:opacity-40 shrink-0"> <Upload size={12} /> </button> </div>
                          {/* External-source switch. On = we only ever link to
                              this file; uploading is disabled so nothing lands
                              on our disk by accident. */}
                          <label className="mt-2 flex items-start justify-between gap-3 p-2.5 bg-white dark:bg-[#1c1c1e] rounded-xl border border-slate-200 dark:border-white/10 cursor-pointer hover:border-amber-300 transition-colors">
                            <span className="min-w-0">
                              <span className="block text-[9px] font-black uppercase tracking-wider text-slate-700 dark:text-slate-200">{ta.externalFileLabel}</span>
                              {f.external && (
                                <span className="block text-[8px] font-bold text-slate-400 dark:text-slate-500 leading-relaxed mt-0.5">{ta.externalFileHint}</span>
                              )}
                            </span>
                            <span className="relative shrink-0">
                              <input
                                type="checkbox" className="bg-white dark:bg-black/30 sr-only peer border border-slate-300 dark:border-white/15 focus:border-red-600 hover:border-red-400 dark:hover:border-red-500/50 dark:focus:border-red-500 transition-colors"
                                checked={!!f.external}
                                onChange={e => handleUpdateFormat(f.id, 'external', e.target.checked)}
                              />
                              <span className="block w-10 h-6 bg-slate-200 dark:bg-white/10 rounded-full peer peer-checked:bg-amber-500 transition-all after:content-[''] after:absolute after:top-[3px] after:left-[3px] after:bg-white after:rounded-full after:h-[18px] after:w-[18px] after:transition-all peer-checked:after:translate-x-4" />
                            </span>
                          </label>
                          {stagedContentFile?.formatId === f.id && !uploadState && ( <div className="mt-1 flex items-center gap-1.5 p-1.5 bg-blue-50 rounded-lg border border-blue-100"> <span className="text-[8px] font-bold text-blue-700 flex-1 truncate">{stagedContentFile.file.name} ({formatFileSize(stagedContentFile.file.size)})</span> <button type="button" onClick={() => editingItem?.id && uploadContentFile(editingItem.id, f.id, f.language ||'ru')} className="px-2 py-0.5 bg-blue-600 text-white text-[8px] font-black rounded shrink-0">{ta.uploadBtn}</button>
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
                          <input placeholder="2.4 MB" className="w-full dark:bg-black/30 bg-white border border-slate-300 rounded-lg px-2 py-1.5 text-[9px] font-bold outline-none focus:border-red-600 dark:border-white/15 hover:border-red-400 dark:hover:border-red-500/50 dark:focus:border-red-500 transition-colors"
                            value={f.size || ''} onChange={e => handleUpdateFormat(f.id, 'size', e.target.value)} /> </div> </div> <button type="button" onClick={() => handleDeleteFormat(f)} className="mt-2 w-full py-2 bg-red-50 text-red-500 rounded-xl text-[9px] font-black uppercase tracking-widest hover:bg-red-600 hover:text-white transition-colors flex items-center justify-center gap-1.5" > <Trash2 size={11} /> {ta.deleteFileServer} </button> </div> ); })} {(!editingItem.formats || editingItem.formats.length === 0) && ( <p className="text-center text-[9px] text-slate-300 dark:text-slate-600 font-bold uppercase py-3">{ta.noFiles}</p> )} <input ref={fileInputRef} type="file" accept=".pdf,.epub,.fb2,.djvu,.djv,.mp4,.webm,.mkv,.mp3,.m4a,.m4b,.ogg,.oga,.opus,.wav" className="bg-white dark:bg-black/30 hidden border border-slate-300 dark:border-white/15 focus:border-red-600 hover:border-red-400 dark:hover:border-red-500/50 dark:focus:border-red-500 transition-colors" onChange={e => { const file = e.target.files?.[0]; const id = uploadingFormatId.current; if (file && id) setStagedContentFile({ file, formatId: id }); }} /> </div> </div>

                    <div>
                <p className="text-[8px] font-black uppercase text-red-600 tracking-widest mb-3">{ta.sourceSection}</p>
                <div className="space-y-2 p-3 bg-slate-50 dark:bg-black/40 rounded-2xl border border-slate-100 dark:border-white/[0.08]">
                  <div>
                    <label className="text-[8px] font-black uppercase text-slate-400 dark:text-slate-500 ml-1">{ta.sourceNameLabel}</label>
                    <input
                      type="text" placeholder={ta.sourceNamePlaceholder}
                      className="w-full bg-white dark:bg-black/30 border border-slate-300 dark:border-white/15 rounded-xl px-3 py-2 text-xs font-bold focus:border-red-600 outline-none hover:border-red-400 dark:hover:border-red-500/50 dark:focus:border-red-500 transition-colors"
                      value={editingItem.source?.name || ''}
                      onChange={e => setEditingItem({ ...editingItem, source: { ...(editingItem.source || {}), name: e.target.value } })}
                    />
                  </div>
                  <div>
                    <label className="text-[8px] font-black uppercase text-slate-400 dark:text-slate-500 ml-1">{ta.sourceUrlLabel}</label>
                    <input
                      type="text" placeholder={ta.sourceUrlPlaceholder}
                      className="w-full bg-white dark:bg-black/30 border border-slate-300 dark:border-white/15 rounded-xl px-3 py-2 text-xs font-bold focus:border-red-600 outline-none hover:border-red-400 dark:hover:border-red-500/50 dark:focus:border-red-500 transition-colors"
                      value={editingItem.source?.url || ''}
                      onChange={e => setEditingItem({ ...editingItem, source: { ...(editingItem.source || { name: '' }), url: e.target.value } })}
                    />
                  </div>
                </div>
              </div>

                    <div> <p className="text-[8px] font-black uppercase text-red-600 tracking-widest mb-3">{ta.contentLangs}</p> <div className="grid grid-cols-3 gap-2"> {(['ru', 'en', 'es', 'it', 'fr', 'de'] as const).map(l => {
                    const active = (editingItem.contentLanguages || []).includes(l);
                    return (
                      <button key={l} type="button" onClick={() => handleToggleContentLang(l)}
                        className={`py-3 rounded-xl text-[10px] font-black uppercase tracking-widest border transition-all ${active ? 'bg-slate-900 text-white border-slate-900' : 'bg-slate-50 dark:bg-black/40 text-slate-400 dark:text-slate-500 border-slate-100 dark:border-white/[0.08] hover:border-slate-300'}`}>
                        {l}
                      </button>
                    );
                  })}
                </div>
              </div>
                  </EditorGroup>

                  {/* ── 3 · Описание ────────────────────────────────────── */}
                  <EditorGroup n={3} title={ta.groupDescription} open={!!openGroups.groupDescription} onToggle={() => toggleGroup('groupDescription')}>
                    <div>
                <p className="text-[8px] font-black uppercase text-red-600 tracking-widest mb-3">{ta.descriptionsLabel}</p>
                <div className="space-y-3">
                  {(['ru', 'en', 'es'] as const).map(l => ( <div key={l}> <label className="text-[8px] font-black uppercase text-slate-400 dark:text-slate-500 ml-2">{l} {ta.descriptionWord}</label> <textarea rows={8} className="w-full min-h-[9rem] bg-white dark:bg-black/30 border border-slate-300 dark:border-white/15 rounded-2xl px-4 py-3 text-xs font-medium leading-relaxed focus:border-red-600 outline-none resize-y hover:border-red-400 dark:hover:border-red-500/50 dark:focus:border-red-500 transition-colors" value={editingItem.description?.[l] ||''}
                        onChange={e => setEditingItem({...editingItem, description: {...(editingItem.description || {en:'',ru:'',es:''}), [l]: e.target.value}})} /> </div> ))} </div> </div>
                  </EditorGroup>

                  {/* ── 4 · Каталог ─────────────────────────────────────── */}
                  <EditorGroup n={4} title={ta.groupCatalog} badge={catalogFilled} open={!!openGroups.groupCatalog} onToggle={() => toggleGroup('groupCatalog')}>
                    {/* Scholarly identifiers. Optional and inside the collapsed
                        Catalogue group, because most items (videos, courses,
                        books) have no DOI and shouldn't be asked for one. */}
                    <div>
                      <p className="text-[8px] font-black uppercase text-red-600 tracking-widest mb-3">{ta.publicationSection}</p>
                      <div className="space-y-2 p-3 bg-slate-50 dark:bg-black/40 rounded-2xl border border-slate-100 dark:border-white/[0.08]">
                        <div>
                          <label className="text-[8px] font-black uppercase text-slate-400 dark:text-slate-500 ml-1">{ta.doiLabel}</label>
                          <div className="flex gap-1.5">
                            <input
                              type="text" placeholder={ta.doiPlaceholder}
                              className="flex-1 min-w-0 bg-white dark:bg-black/30 border border-slate-300 dark:border-white/15 rounded-xl px-3 py-2 text-[11px] font-mono font-bold focus:border-red-600 outline-none hover:border-red-400 dark:hover:border-red-500/50 dark:focus:border-red-500 transition-colors"
                              value={editingItem.publication?.doi || ''}
                              onChange={e => setEditingItem({ ...editingItem, publication: { ...(editingItem.publication || {}), doi: e.target.value } })}
                            />
                            <button
                              type="button"
                              onClick={handleDoiLookup}
                              disabled={doiBusy || !isValidDoi(editingItem.publication?.doi || '')}
                              title={ta.doiFetch}
                              className="px-3 bg-slate-900 dark:bg-white text-white dark:text-slate-900 rounded-xl text-[9px] font-black uppercase tracking-widest shrink-0 disabled:opacity-40 transition-opacity"
                            >
                              {doiBusy ? '…' : ta.doiFetch}
                            </button>
                          </div>
                          <p className="text-[9px] text-slate-400 dark:text-slate-500 mt-1 leading-relaxed">{ta.doiHelp}</p>
                        </div>

                        {!!editingItem.publication?.doi && (
                          <>
                            <div>
                              <label className="text-[8px] font-black uppercase text-slate-400 dark:text-slate-500 ml-1">{ta.publicationTypeLabel}</label>
                              <select
                                className="w-full bg-white dark:bg-black/30 border border-slate-300 dark:border-white/15 rounded-xl px-3 py-2 text-xs font-bold focus:border-red-600 outline-none hover:border-red-400 dark:hover:border-red-500/50 dark:focus:border-red-500 transition-colors"
                                value={editingItem.publication?.type || ''}
                                onChange={e => setEditingItem({ ...editingItem, publication: { ...(editingItem.publication || { doi: '' }), type: e.target.value } })}
                              >
                                <option value="">—</option>
                                {/* A type the registry returned that isn't in our list is kept
                                    as an option of its own rather than silently reset. */}
                                {editingItem.publication?.type && !getPublicationType(editingItem.publication.type) && (
                                  <option value={editingItem.publication.type}>
                                    {publicationTypeLabel(editingItem.publication.type, lang)}
                                  </option>
                                )}
                                {PUBLICATION_TYPES.map(pt => (
                                  <option key={pt.code} value={pt.code}>{pt[lang] || pt.en}</option>
                                ))}
                              </select>
                            </div>
                            <div>
                              <label className="text-[8px] font-black uppercase text-slate-400 dark:text-slate-500 ml-1">{ta.journalLabel}</label>
                              <input
                                type="text" placeholder={ta.journalPlaceholder}
                                className="w-full bg-white dark:bg-black/30 border border-slate-300 dark:border-white/15 rounded-xl px-3 py-2 text-xs font-bold focus:border-red-600 outline-none hover:border-red-400 dark:hover:border-red-500/50 dark:focus:border-red-500 transition-colors"
                                value={editingItem.publication?.journal || ''}
                                onChange={e => setEditingItem({ ...editingItem, publication: { ...(editingItem.publication || { doi: '' }), journal: e.target.value } })}
                              />
                            </div>
                            <div>
                              <label className="text-[8px] font-black uppercase text-slate-400 dark:text-slate-500 ml-1">{ta.publisherLabel}</label>
                              <input
                                type="text" placeholder={ta.publisherPlaceholder}
                                className="w-full bg-white dark:bg-black/30 border border-slate-300 dark:border-white/15 rounded-xl px-3 py-2 text-xs font-bold focus:border-red-600 outline-none hover:border-red-400 dark:hover:border-red-500/50 dark:focus:border-red-500 transition-colors"
                                value={editingItem.publication?.publisher || ''}
                                onChange={e => setEditingItem({ ...editingItem, publication: { ...(editingItem.publication || { doi: '' }), publisher: e.target.value } })}
                              />
                            </div>
                          </>
                        )}
                      </div>
                    </div>

                    <div> <p className="text-[8px] font-black uppercase text-red-600 tracking-widest mb-3">{ta.seriesAndTags}</p> <div className="space-y-3"> <div className="flex gap-3"> <div className="flex-1"> <label className="text-[8px] font-black uppercase text-slate-400 ml-2">{ta.seriesName}</label> <input type="text" placeholder={ta.seriesNamePh} className="w-full dark:bg-black/30 bg-white border border-slate-300 rounded-2xl px-4 py-3 text-xs font-bold focus:border-red-600 outline-none dark:border-white/15 hover:border-red-400 dark:hover:border-red-500/50 dark:focus:border-red-500 transition-colors" value={editingItem.series ||''} onChange={e => setEditingItem({...editingItem, series: e.target.value})} list="series-suggestions" /> <datalist id="series-suggestions"> {Array.from(new Set(db.items.map(i => i.series).filter(Boolean))).map(s => ( <option key={s} value={s} /> ))} </datalist> </div> <div className="w-24"> <label className="text-[8px] font-black uppercase text-slate-400 dark:text-slate-500 ml-2">{ta.seriesOrder}</label> <input type="number" min="1" step="1" placeholder="1" className="w-full bg-white dark:bg-black/30 border border-slate-300 dark:border-white/15 rounded-2xl px-4 py-3 text-xs font-bold focus:border-red-600 outline-none hover:border-red-400 dark:hover:border-red-500/50 dark:focus:border-red-500 transition-colors" value={editingItem.seriesOrder ??''} onChange={e => setEditingItem({...editingItem, seriesOrder: e.target.value ? parseInt(e.target.value) : undefined})} /> </div> </div> <div> <label className="text-[8px] font-black uppercase text-slate-400 dark:text-slate-500 ml-2">{ta.tagsLabel}</label> {/* Chip-style tag input: existing chips with X to remove, free-text buffer at the end that commits on space / comma / Enter. Backspace on empty buffer removes the last chip. */} <div className="w-full bg-white dark:bg-black/30 border border-slate-300 dark:border-white/15 rounded-2xl px-3 py-2 min-h-[3rem] flex flex-wrap items-center gap-1.5 hover:border-red-400 dark:hover:border-red-500/50 focus-within:border-red-600 dark:focus-within:border-red-500 transition-colors cursor-text" onClick={() => (document.getElementById('tag-buffer-input') as HTMLInputElement | null)?.focus()}
                    >
                      {(editingItem.tags || []).map(tag => (
                        <span key={tag} className="inline-flex items-center gap-1 pl-2.5 pr-1 py-1 rounded-lg bg-red-50 text-red-700 text-[11px] font-bold">
                          #{tag}
                          <button
                            type="button"
                            onClick={e => { e.stopPropagation(); removeTag(tag); }}
                            className="p-0.5 hover:bg-red-100 rounded transition-colors"
                            aria-label={`Remove ${tag}`}
                          >
                            <X size={11} strokeWidth={3} />
                          </button>
                        </span>
                      ))}
                      <input
                        id="tag-buffer-input"
                        type="text"
                        placeholder={(editingItem.tags || []).length === 0 ? ta.tagsPlaceholder : ''}
                        className="flex-1 min-w-[6rem] bg-transparent text-xs font-bold outline-none placeholder:text-slate-400"
                        value={tagInput}
                        onChange={e => handleTagInputChange(e.target.value)}
                        onKeyDown={handleTagInputKeyDown}
                        onBlur={() => { if (tagInput.trim()) { commitTagBuffer(tagInput); setTagInput(''); } }} /> </div> <p className="text-[9px] text-slate-400 dark:text-slate-500 mt-1 ml-2">{ta.tagsHelp}</p> </div> </div> </div>

                    <div className="border-2 border-dashed border-red-200 bg-red-50/40 rounded-3xl p-4"> <div className="flex items-center justify-between mb-2"> <div className="flex items-center gap-2"> <div className="p-1.5 bg-red-600 rounded-lg text-white"><Newspaper size={14} /></div> <p className="text-[11px] font-black uppercase text-red-600 tracking-widest">{ta.articlesLabel}</p> </div> <button type="button" onClick={handleAddArticle} className="flex items-center gap-1.5 text-[10px] font-black uppercase bg-red-600 text-white px-3 py-2 rounded-xl shadow-md shadow-red-200 hover:bg-red-700 active:scale-95 transition-all" > <PlusIcon size={12} strokeWidth={3} /> {ta.addArticle} </button> </div> <p className="text-[10px] text-slate-500 leading-relaxed mb-3">{ta.articlesHelp}</p> <div className="space-y-2"> {(editingItem.articles || []).map(a => { const presets = ['Web', 'Twitter', 'X', 'YandexZen', 'VK', 'Telegram']; const isCustom = !presets.includes(a.source); return ( <div key={a.id} className="relative p-2.5 pl-9 bg-white dark:bg-[#1c1c1e] rounded-2xl border border-red-100 space-y-2"> <button type="button" onClick={() => handleRemoveArticle(a.id)} className="absolute top-2.5 left-2 p-1 text-slate-300 dark:text-slate-600 hover:text-red-500"><X size={14} /></button> <div className="flex flex-wrap items-center gap-2"> <select value={isCustom ?'__custom__' : a.source}
                            onChange={e => handleUpdateArticle(a.id, 'source', e.target.value === '__custom__' ? '': e.target.value)} className="bg-white border border-slate-200 dark:border-white/10 rounded-xl px-3 py-2 text-[11px] font-bold focus:border-red-600 outline-none"> {presets.map(p => <option key={p} value={p}>{p}</option>)} <option value="__custom__">{ta.customSource}</option> </select> <select value={a.language ||'ru'}
                            onChange={e => handleUpdateArticle(a.id, 'language', e.target.value)} className="bg-white border border-slate-200 dark:border-white/10 rounded-xl px-3 py-2 text-[11px] font-bold focus:border-red-600 outline-none"> <option value="ru">RU</option><option value="en">EN</option><option value="es">ES</option> <option value="it">IT</option><option value="fr">FR</option><option value="de">DE</option> </select> {isCustom && ( <input type="text" placeholder={ta.sourceName} className="flex-1 min-w-0 bg-white dark:bg-black/30 border border-slate-300 rounded-xl px-3 py-2 text-[11px] font-bold focus:border-red-600 outline-none dark:border-white/15 hover:border-red-400 dark:hover:border-red-500/50 dark:focus:border-red-500 transition-colors" value={a.source} onChange={e => handleUpdateArticle(a.id,'source', e.target.value)} /> )} </div> <input type="url" placeholder="https://dzen.ru/a/... · https://x.com/user/status/... · https://vk.com/wall..." className="w-full bg-white dark:bg-black/30 border border-slate-300 dark:border-white/15 rounded-xl px-3 py-2 text-[11px] font-bold focus:border-red-600 outline-none hover:border-red-400 dark:hover:border-red-500/50 dark:focus:border-red-500 transition-colors" value={a.url} onChange={e => handleUpdateArticle(a.id,'url', e.target.value)} /> <input type="text" placeholder={ta.articleTitlePh} className="w-full bg-white dark:bg-black/30 border border-slate-300 dark:border-white/15 rounded-xl px-3 py-2 text-[11px] font-bold focus:border-red-600 outline-none hover:border-red-400 dark:hover:border-red-500/50 dark:focus:border-red-500 transition-colors" value={a.title ||''} onChange={e => handleUpdateArticle(a.id, 'title', e.target.value)} /> </div> ); })} {(!editingItem.articles || editingItem.articles.length === 0) && ( <button type="button" onClick={handleAddArticle} className="w-full py-4 border-2 border-dashed border-red-300 rounded-2xl text-[10px] font-black uppercase tracking-widest text-red-500 hover:bg-red-100 hover:border-red-400 transition-colors flex items-center justify-center gap-2" > <PlusIcon size={14} strokeWidth={3} /> {ta.addFirstArticle} </button> )} </div> </div>
                  </EditorGroup>

                  {/* ── 5 · Доступ и лицензия ───────────────────────────── */}
                  <EditorGroup n={5} title={ta.groupAccess} badge={accessFilled} open={!!openGroups.groupAccess} onToggle={() => toggleGroup('groupAccess')}>
                    <div>
                <p className="text-[8px] font-black uppercase text-red-600 tracking-widest mb-3">{ta.accessRights}</p>
                <div className="space-y-2">
                  {([
                    { key: 'isPrivate' as const,      label: ta.whitelistOnly },
                    { key: 'allowDownload' as const,  label: ta.allowDownloadLabel },
                    { key: 'allowReading'as const, label: ta.allowReadingLabel }, ]).map(({ key, label }) => ( <label key={key} className="flex items-center justify-between p-3 bg-slate-50 dark:bg-black/40 rounded-2xl border border-slate-100 dark:border-white/[0.08] cursor-pointer hover:border-red-100 transition-all"> <span className="text-xs font-bold text-slate-700">{label}</span> <div className="relative"> <input type="checkbox" className="bg-white dark:bg-black/30 sr-only peer border border-slate-300 dark:border-white/15 focus:border-red-600 hover:border-red-400 dark:hover:border-red-500/50 dark:focus:border-red-500 transition-colors" checked={!!(editingItem as any)[key]} onChange={e => setEditingItem({...editingItem, [key]: e.target.checked})} /> <div className="w-10 h-6 bg-slate-200 rounded-full peer peer-checked:bg-red-600 transition-all after:content-[''] after:absolute after:top-[3px] after:left-[3px] after:bg-white after:rounded-full after:h-[18px] after:w-[18px] after:transition-all peer-checked:after:translate-x-4" />
                      </div>
                    </label>
                  ))}
                </div>
              </div>

                    <div>
                <p className="text-[8px] font-black uppercase text-red-600 tracking-widest mb-3">{ta.licenseSection}</p>
                <div className="space-y-2 p-3 bg-slate-50 dark:bg-black/40 rounded-2xl border border-slate-100 dark:border-white/[0.08]">
                  <div>
                    <label className="text-[8px] font-black uppercase text-slate-400 dark:text-slate-500 ml-1">{ta.licenseSelectLabel}</label>
                    <select
                      className="w-full bg-white dark:bg-black/30 border border-slate-300 dark:border-white/15 rounded-xl px-3 py-2 text-xs font-bold focus:border-red-600 outline-none hover:border-red-400 dark:hover:border-red-500/50 dark:focus:border-red-500 transition-colors"
                      value={editingItem.license?.code || ''}
                      onChange={e => {
                        const code = e.target.value;
                        if (!code) { const { license, ...rest } = editingItem; setEditingItem(rest); return; }
                        // Presets carry a canonical URL; adopt it so the item page
                        // can link the licence text without the admin pasting it.
                        setEditingItem({
                          ...editingItem,
                          license: {
                            ...(editingItem.license || {}),
                            code,
                            url: getLicensePreset(code)?.url || '',
                          },
                        });
                      }}
                    >
                      <option value="">—</option>
                      {LICENSE_PRESETS.map(p => (
                        <option key={p.code} value={p.code}>{p[lang] || p.en}</option>
                      ))}
                    </select>
                  </div>

                  {editingItem.license?.code === CUSTOM_LICENSE_CODE && (
                    <div>
                      <label className="text-[8px] font-black uppercase text-slate-400 dark:text-slate-500 ml-1">{ta.licenseCustomNameLabel}</label>
                      <input
                        type="text" placeholder={ta.licenseCustomNamePlaceholder}
                        className="w-full bg-white dark:bg-black/30 border border-slate-300 dark:border-white/15 rounded-xl px-3 py-2 text-xs font-bold focus:border-red-600 outline-none hover:border-red-400 dark:hover:border-red-500/50 dark:focus:border-red-500 transition-colors"
                        value={editingItem.license?.name || ''}
                        onChange={e => setEditingItem({ ...editingItem, license: { ...(editingItem.license || { code: CUSTOM_LICENSE_CODE }), name: e.target.value } })}
                      />
                    </div>
                  )}

                  {editingItem.license?.code && (
                    <>
                      <div>
                        <label className="text-[8px] font-black uppercase text-slate-400 dark:text-slate-500 ml-1">{ta.licenseUrlLabel}</label>
                        <input
                          type="text" placeholder={ta.licenseUrlPlaceholder}
                          className="w-full bg-white dark:bg-black/30 border border-slate-300 dark:border-white/15 rounded-xl px-3 py-2 text-[11px] font-bold focus:border-red-600 outline-none hover:border-red-400 dark:hover:border-red-500/50 dark:focus:border-red-500 transition-colors"
                          value={editingItem.license?.url || ''}
                          onChange={e => setEditingItem({ ...editingItem, license: { ...editingItem.license!, url: e.target.value } })}
                        />
                      </div>
                      <div>
                        <label className="text-[8px] font-black uppercase text-slate-400 dark:text-slate-500 ml-1">{ta.licenseHolderLabel}</label>
                        <input
                          type="text" placeholder={ta.licenseHolderPlaceholder}
                          className="w-full bg-white dark:bg-black/30 border border-slate-300 dark:border-white/15 rounded-xl px-3 py-2 text-xs font-bold focus:border-red-600 outline-none hover:border-red-400 dark:hover:border-red-500/50 dark:focus:border-red-500 transition-colors"
                          value={editingItem.license?.holder || ''}
                          onChange={e => setEditingItem({ ...editingItem, license: { ...editingItem.license!, holder: e.target.value } })}
                        />
                      </div>
                      <div>
                        <label className="text-[8px] font-black uppercase text-slate-400 dark:text-slate-500 ml-1">{ta.licenseNoteLabel}</label>
                        <textarea
                          rows={2} placeholder={ta.licenseNotePlaceholder}
                          className="w-full bg-white dark:bg-black/30 border border-slate-300 dark:border-white/15 rounded-xl px-3 py-2 text-[11px] font-bold focus:border-red-600 outline-none resize-none hover:border-red-400 dark:hover:border-red-500/50 dark:focus:border-red-500 transition-colors"
                          value={editingItem.license?.note || ''}
                          onChange={e => setEditingItem({ ...editingItem, license: { ...editingItem.license!, note: e.target.value } })}
                        />
                      </div>
                      {/* Advisory only — the admin may have a separate agreement. */}
                      {licenseForbidsRedistribution(editingItem.license) && editingItem.allowDownload !== false && (
                        <p className="flex items-start gap-2 text-[10px] font-bold text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/25 rounded-xl p-2.5 leading-relaxed">
                          <AlertCircle size={13} className="shrink-0 mt-px" />{ta.licenseRedistributionWarning}
                        </p>
                      )}
                    </>
                  )}
                </div>
              </div>
                  </EditorGroup>

                  <EditorGroup
                    n={6}
                    title={ta.scan.groupIndex}
                    badge={(indexByItem.get(editingItem.id || '') || []).length || undefined}
                    open={!!openGroups.groupIndexing}
                    onToggle={() => toggleGroup('groupIndexing')}
                  >
                    {(() => {
                      const s = ta.scan;
                      const st = itemIndexState(editingItem as MediaItem);
                      const rows = indexByItem.get(editingItem.id || '') || [];
                      const rowFor = (url: string) => rows.find(r => r.format_url === url.trim());
                      const isSub = (u: string) => /\.(srt|vtt)$/i.test(u.split(/[?#]/)[0]);
                      const num = (n: number) => n.toLocaleString(lang === 'ru' ? 'ru-RU' : lang);

                      // Everything that can end up in the index, named by what it is.
                      const formats = (editingItem.formats || []).filter(f => (f.url || '').trim());
                      const targets: { url: string; name: string; kind: string }[] = [
                        ...formats.map(f => ({
                          url: f.url.trim(),
                          name: f.name || f.url,
                          kind: isSub(f.url) ? s.targetSubtitles : f.external ? s.targetExternal : s.targetFile,
                        })),
                        ...(!formats.length && (editingItem.source?.url || '').trim()
                          ? [{ url: editingItem.source!.url!.trim(), name: editingItem.source?.name || s.targetSource, kind: s.targetSource }]
                          : []),
                        ...((editingItem.videos || []).filter(v => (v.url || '').trim())
                          .map(v => ({ url: v.url.trim(), name: v.source || s.targetVideo, kind: s.targetVideo }))),
                      ];

                      return (
                        <div className="space-y-3">
                          <p className="text-[10px] text-slate-500 dark:text-slate-400 font-bold leading-relaxed">{s.groupIndexHint}</p>

                          {targets.length === 0 ? (
                            <p className="text-[10px] font-bold text-slate-400 dark:text-slate-500 py-4 text-center">{s.noTargets}</p>
                          ) : (
                            <div className="space-y-2">
                              {targets.map(t => {
                                const r = rowFor(t.url);
                                const tone = !r
                                  ? 'bg-slate-100 text-slate-500 border-slate-200 dark:bg-white/5 dark:text-slate-400 dark:border-white/10'
                                  : r.state === 'indexed'
                                    ? 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-400 dark:border-emerald-500/25'
                                    : r.state === 'failed'
                                      ? 'bg-red-50 text-red-700 border-red-200 dark:bg-red-500/10 dark:text-red-400 dark:border-red-500/25'
                                      : 'bg-slate-100 text-slate-500 border-slate-200 dark:bg-white/5 dark:text-slate-400 dark:border-white/10';
                                return (
                                  <div key={t.url} className="p-3 rounded-2xl bg-white dark:bg-black/30 border border-slate-200 dark:border-white/10">
                                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                                      <span className={`px-2 py-0.5 rounded-lg border text-[8px] font-black uppercase tracking-widest ${tone}`}>
                                        {!r ? s.cardNotIndexed
                                          : r.state === 'indexed' ? s.indexStateIndexed
                                          : r.state === 'failed' ? s.indexStateFailed
                                          : s.indexStateSkipped}
                                      </span>
                                      <span className="text-[8px] font-black uppercase tracking-widest text-slate-400 dark:text-slate-500">{t.kind}</span>
                                      <span className="text-[11px] font-black text-slate-800 dark:text-slate-100 truncate min-w-0 flex-1">{t.name}</span>
                                      {r?.state === 'indexed' && (
                                        <span className="text-[8px] font-black uppercase tracking-widest text-slate-400 dark:text-slate-500 tabular-nums">
                                          {num(r.pages || 0)} {r.method === 'subtitles' || r.method === 'asr' ? s.cues : s.pages}
                                          {' · '}{num(r.chunk_count || 0)} {s.indexChunks}
                                          {r.quality !== null && ` · ${r.quality.toFixed(2)}`}
                                        </span>
                                      )}
                                    </div>
                                    {r?.detail && (
                                      <p className={`text-[9px] font-bold leading-snug mt-1.5 break-words ${r.state === 'failed' ? 'text-red-500' : 'text-slate-400 dark:text-slate-500'}`}>
                                        {r.detail}
                                      </p>
                                    )}
                                    {/* Spoken material has two routes to the same
                                        transcript. Cheap one first, and each says
                                        what it costs, so the choice is informed
                                        rather than a coin toss. */}
                                    {r?.state === 'indexed' && (
                                      <button
                                        type="button"
                                        onClick={() => openPages(r)}
                                        className="mt-2 px-3 py-1.5 rounded-xl bg-white dark:bg-white/[0.06] border border-slate-300 dark:border-white/15 text-[9px] font-black uppercase tracking-widest text-slate-600 dark:text-slate-300 hover:border-red-400 hover:text-red-600 transition-colors"
                                      >
                                        {s.indexPages}
                                      </button>
                                    )}
                                    {(t.kind === s.targetVideo || /\.(mp4|webm|mkv|mp3|m4a|m4b|ogg|oga|opus|wav)$/i.test(t.url.split(/[?#]/)[0])) && (
                                      <div className="flex flex-wrap gap-2 mt-2.5">
                                        {t.kind === s.targetVideo && (
                                          <button
                                            type="button"
                                            onClick={() => handleTranscribe('platform-subs', { itemId: editingItem.id, targetUrl: t.url })}
                                            title={s.subsFromPlatformHint}
                                            className="px-3 py-1.5 rounded-xl bg-red-600 hover:bg-red-700 text-white text-[9px] font-black uppercase tracking-widest transition-colors"
                                          >
                                            {s.subsFromPlatform}
                                          </button>
                                        )}
                                        <button
                                          type="button"
                                          onClick={() => handleTranscribe('asr', { itemId: editingItem.id, targetUrl: t.url })}
                                          title={s.runAsrHint}
                                          className="px-3 py-1.5 rounded-xl bg-white dark:bg-white/[0.06] border border-slate-300 dark:border-white/15 text-[9px] font-black uppercase tracking-widest text-slate-600 dark:text-slate-300 hover:border-red-400 hover:text-red-600 transition-colors"
                                        >
                                          {s.runAsr}
                                        </button>
                                      </div>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                          )}

                          <div className="flex flex-wrap gap-2 pt-1">
                            {st.canIndexDocuments && (
                              <button
                                type="button"
                                onClick={() => handleIndexRun(editingItem.id)}
                                disabled={indexReport?.job?.running}
                                className="flex items-center gap-2 px-4 py-2.5 bg-red-600 hover:bg-red-700 text-white rounded-2xl text-[10px] font-black uppercase tracking-widest shadow-md disabled:opacity-40 active:scale-95 transition-all"
                              >
                                <RefreshCw size={12} strokeWidth={3} className={indexReport?.job?.running ? 'animate-spin' : ''} /> {s.runIndexHere}
                              </button>
                            )}
                            {st.spoken > 0 && (
                              <button
                                type="button"
                                onClick={() => subtitleInputRef.current?.click()}
                                disabled={subtitleBusy}
                                className="flex items-center gap-2 px-4 py-2.5 bg-white dark:bg-white/[0.06] border border-slate-300 dark:border-white/15 rounded-2xl text-[10px] font-black uppercase tracking-widest text-slate-600 dark:text-slate-300 hover:border-red-400 hover:text-red-600 disabled:opacity-40 active:scale-95 transition-all"
                              >
                                <Upload size={12} strokeWidth={3} /> {s.uploadSubs}
                              </button>
                            )}
                            {st.canImportSubtitles && (
                              <button
                                type="button"
                                onClick={() => handleQueueSubtitles(editingItem.id)}
                                className="flex items-center gap-2 px-4 py-2.5 bg-white dark:bg-white/[0.06] border border-slate-300 dark:border-white/15 rounded-2xl text-[10px] font-black uppercase tracking-widest text-slate-600 dark:text-slate-300 hover:border-red-400 hover:text-red-600 active:scale-95 transition-all"
                              >
                                <Video size={12} strokeWidth={3} /> {s.runSubsHere}
                              </button>
                            )}
                            {rows.length > 0 && (
                              <button
                                type="button"
                                onClick={() => handleUnindex(editingItem.id!)}
                                className="flex items-center gap-2 px-4 py-2.5 bg-white dark:bg-white/[0.06] border border-slate-300 dark:border-white/15 rounded-2xl text-[10px] font-black uppercase tracking-widest text-slate-600 dark:text-slate-300 hover:border-red-400 hover:text-red-600 active:scale-95 transition-all"
                              >
                                <Trash2 size={12} strokeWidth={3} /> {s.unindex}
                              </button>
                            )}
                          </div>

                          {(() => {
                            const mine = jobs.filter(j => j.item_id === editingItem.id
                              && ['queued', 'running', 'failed'].includes(j.state));
                            const recent = jobs.filter(j => j.item_id === editingItem.id && j.state === 'done').slice(0, 2);
                            const shown = [...mine, ...recent];
                            if (!shown.length) return null;
                            return (
                              <div className="space-y-2 pt-1">
                                <div className="flex justify-end">
                                  <button
                                    type="button"
                                    onClick={() => handleClearHistory(editingItem.id)}
                                    className="text-[9px] font-black uppercase tracking-widest text-slate-400 hover:text-red-600 transition-colors"
                                  >
                                    {s.clearHistory}
                                  </button>
                                </div>
                                {shown.map(j => (
                                  <div key={j.id} className="p-2.5 rounded-xl bg-white dark:bg-black/30 border border-slate-200 dark:border-white/10">
                                    <div className="flex items-center gap-2 flex-wrap">
                                      <span className={`px-2 py-0.5 rounded-lg text-[8px] font-black uppercase tracking-widest
                                        ${j.state === 'running' ? 'bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-400'
                                          : j.state === 'queued' ? 'bg-slate-100 text-slate-500 dark:bg-white/5 dark:text-slate-400'
                                          : j.state === 'failed' ? 'bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-400'
                                          : 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400'}`}>
                                        {j.state === 'running' ? s.queueRunning : j.state === 'queued' ? s.queueQueued
                                          : j.state === 'failed' ? s.queueFailed : s.queueDone}
                                      </span>
                                      <span className="text-[9px] font-bold text-slate-500 dark:text-slate-400 truncate min-w-0 flex-1">{j.label}</span>
                                      {j.state === 'running' && (
                                        <div className="w-20 h-1.5 bg-slate-200 dark:bg-white/10 rounded-full overflow-hidden shrink-0">
                                          <div className="h-full bg-red-600 rounded-full transition-all duration-500" style={{ width: `${Math.round(j.progress * 100)}%` }} />
                                        </div>
                                      )}
                                      {j.state === 'failed' && (
                                        <button type="button" onClick={() => handleJobAction(j.id, 'retry')}
                                          className="px-2 py-1 rounded-lg border border-slate-300 dark:border-white/15 text-[8px] font-black uppercase tracking-widest text-slate-500 hover:border-red-400 hover:text-red-600 transition-colors">
                                          {s.queueRetry}
                                        </button>
                                      )}
                                    </div>
                                    {j.detail && (
                                      <p className={`text-[9px] font-bold leading-snug mt-1 break-words ${j.state === 'failed' ? 'text-red-500' : 'text-slate-400 dark:text-slate-500'}`}>
                                        {j.detail}
                                      </p>
                                    )}
                                  </div>
                                ))}
                              </div>
                            );
                          })()}

                          <input
                            ref={subtitleInputRef}
                            type="file"
                            accept=".srt,.vtt"
                            className="hidden"
                            onChange={e => { const f = e.target.files?.[0]; if (f) uploadSubtitleFile(f); }}
                          />

                          {st.kind === 'needsSubtitles' && (
                            <p className="text-[9px] font-bold text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/25 rounded-2xl px-4 py-3">
                              {s.cardNeedsSubtitles} — {s.stateMediaHint}
                            </p>
                          )}
                        </div>
                      );
                    })()}
                  </EditorGroup>
              </div> <div className="p-4 bg-slate-50 dark:bg-black/40 border-t border-slate-100"> <button onClick={handleSaveItem} className="w-full py-4 bg-red-600 text-white rounded-2xl font-black uppercase tracking-widest shadow-xl shadow-red-200">{ta.saveAsset}</button> </div> </div> </div> )} {/* ── Restore confirmation modal ─────────────────────────────────────── */} {restoreTarget && ( <div className="fixed inset-0 z-[600] flex items-center justify-center p-6 bg-black/50 backdrop-blur-sm"> <div className="w-full max-w-md bg-white rounded-3xl shadow-2xl p-6"> <div className="w-12 h-12 rounded-2xl bg-amber-50 flex items-center justify-center mb-4"> <RotateCcw size={22} className="text-amber-600" /> </div> <h3 className="text-base font-black text-slate-900 mb-1">{ta.backupRestoreConfirm}</h3> <p className="text-xs text-slate-500 leading-relaxed mb-2">{ta.backupRestoreDesc}</p> <p className="text-xs font-mono font-bold text-slate-700 truncate mb-4 bg-slate-50 p-2 rounded-lg">{restoreTarget}</p> <label className="text-[8px] font-black uppercase tracking-widest text-slate-400 mb-2 block">{ta.backupRestoreConfirmType}</label> <input autoFocus value={restoreConfirm} onChange={e => setRestoreConfirm(e.target.value)} placeholder="RESTORE" className="w-full bg-slate-50 border-2 border-slate-200 dark:border-white/10 rounded-2xl px-4 py-3 text-sm font-bold focus:border-amber-500 outline-none mb-4" /> <div className="flex gap-3"> <button onClick={() => { setRestoreTarget(null); setRestoreConfirm(''); }} className="flex-1 py-3 rounded-2xl text-xs font-black uppercase tracking-widest bg-slate-100 dark:bg-white/[0.06] text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-white/10 transition-colors" > {ta.cancel} </button> <button onClick={() => triggerRestore(restoreTarget)} disabled={restoreConfirm.trim().toUpperCase() !=='RESTORE'|| backupBusy} className="flex-1 py-3 rounded-2xl text-xs font-black uppercase tracking-widest bg-amber-600 text-white hover:bg-amber-700 disabled:opacity-40 transition-colors" > {ta.backupRestore} </button> </div> </div> </div> )} {/* ── Backup config modal ────────────────────────────────────────────── */} {showBackupConfig && backupCfgDraft && ( <div className="fixed inset-0 z-[600] bg-slate-900/40 backdrop-blur-xl flex items-end md:items-center justify-center p-0 md:p-5"> <div className="bg-white w-full md:max-w-2xl rounded-t-[2rem] md:rounded-[3rem] border border-white shadow-2xl overflow-hidden h-[90vh] md:max-h-[85vh] flex flex-col"> <div className="p-5 border-b border-slate-100 dark:border-white/[0.08] flex justify-between items-center sticky top-0 bg-white dark:bg-[#1c1c1e] z-10 shrink-0"> <h3 className="text-base font-black uppercase tracking-tighter">{ta.backupConfigure}</h3> <button onClick={() => setShowBackupConfig(false)} className="p-2 bg-slate-50 rounded-full hover:bg-red-50 dark:hover:bg-red-500/20 hover:text-red-600"><X size={20} /></button> </div> <div className="p-5 overflow-y-auto space-y-6 flex-1"> {/* Schedule */} <div> <p className="text-[8px] font-black uppercase text-red-600 tracking-widest mb-3">{ta.backupSchedule}</p> <div className="p-4 bg-slate-50 rounded-2xl border border-slate-100 space-y-3"> <label className="flex items-center justify-between cursor-pointer"> <span className="text-xs font-bold text-slate-700">{ta.backupAutomaticBackups}</span> <div className="relative"> <input type="checkbox" className="sr-only peer" checked={!!backupCfgDraft.schedule?.enabled} onChange={e => setBackupCfgDraft({...backupCfgDraft, schedule: {...(backupCfgDraft.schedule || {}), enabled: e.target.checked}})} /> <div className="w-10 h-6 bg-slate-200 rounded-full peer peer-checked:bg-red-600 transition-all after:content-[''] after:absolute after:top-[3px] after:left-[3px] after:bg-white after:rounded-full after:h-[18px] after:w-[18px] after:transition-all peer-checked:after:translate-x-4" /> </div> </label> <div> <label className="text-[8px] font-black uppercase text-slate-400 dark:text-slate-500 ml-1">{ta.backupIntervalHours}</label> <input type="number" min="1" max="168" className="w-full bg-white dark:bg-[#1c1c1e] border border-slate-200 dark:border-white/10 rounded-xl px-3 py-2 text-xs font-bold focus:border-red-500 outline-none" value={backupCfgDraft.schedule?.intervalHours ?? 6} onChange={e => setBackupCfgDraft({...backupCfgDraft, schedule: {...(backupCfgDraft.schedule || {}), intervalHours: parseInt(e.target.value) || 6}})} /> </div> </div> </div> {/* Target #1 — Local (active by default) */} <div> <div className="flex items-center justify-between mb-3"> <p className="text-[8px] font-black uppercase text-red-600 tracking-widest flex items-center gap-2"> <HardDrive size={11} /> {ta.backupTargetLocal} <span className="text-green-600">●</span> </p> <label className="relative inline-flex items-center cursor-pointer"> <input type="checkbox" className="sr-only peer" checked={!!backupCfgDraft.targets?.local?.enabled} onChange={e => setBackupCfgDraft({...backupCfgDraft, targets: {...backupCfgDraft.targets, local: {...(backupCfgDraft.targets?.local || {}), enabled: e.target.checked}}})} /> <div className="w-10 h-6 bg-slate-200 rounded-full peer peer-checked:bg-red-600 transition-all after:content-[''] after:absolute after:top-[3px] after:left-[3px] after:bg-white after:rounded-full after:h-[18px] after:w-[18px] after:transition-all peer-checked:after:translate-x-4" /> </label> </div> <p className="text-[10px] text-slate-400 dark:text-slate-500 leading-relaxed">{ta.backupLocalDesc}</p> </div> {/* Target #2 — Remote VPS (disabled by default) */} <div className="opacity-90"> <div className="flex items-center justify-between mb-3"> <p className="text-[8px] font-black uppercase text-red-600 tracking-widest flex items-center gap-2"> <Server size={11} /> {ta.backupTargetRemote} <span className="text-slate-300">●</span> </p> <label className="relative inline-flex items-center cursor-pointer"> <input type="checkbox" className="sr-only peer" checked={!!backupCfgDraft.targets?.remote?.enabled} onChange={e => setBackupCfgDraft({...backupCfgDraft, targets: {...backupCfgDraft.targets, remote: {...(backupCfgDraft.targets?.remote || {}), enabled: e.target.checked}}})} /> <div className="w-10 h-6 bg-slate-200 dark:bg-white/10 rounded-full peer peer-checked:bg-red-600 transition-all after:content-[''] after:absolute after:top-[3px] after:left-[3px] after:bg-white after:rounded-full after:h-[18px] after:w-[18px] after:transition-all peer-checked:after:translate-x-4" /> </label> </div> <p className="text-[10px] text-slate-400 dark:text-slate-500 leading-relaxed mb-3">{ta.backupRemoteDesc}</p> <div className="space-y-2 p-3 bg-slate-50 dark:bg-black/40 rounded-2xl border border-slate-100"> <div className="grid grid-cols-2 gap-2"> <div> <label className="text-[8px] font-black uppercase text-slate-400 ml-1">{ta.backupRemoteHost}</label> <input type="text" placeholder="backup.example.com" className="w-full bg-white border border-slate-200 dark:border-white/10 rounded-lg px-2 py-2 text-[11px] font-bold focus:border-red-500 outline-none" value={backupCfgDraft.targets?.remote?.host ||''} onChange={e => setBackupCfgDraft({...backupCfgDraft, targets: {...backupCfgDraft.targets, remote: {...(backupCfgDraft.targets?.remote || {}), host: e.target.value}}})} /> </div> <div> <label className="text-[8px] font-black uppercase text-slate-400 dark:text-slate-500 ml-1">{ta.backupRemoteUser}</label> <input type="text" placeholder="backup" className="w-full bg-white dark:bg-[#1c1c1e] border border-slate-200 dark:border-white/10 rounded-lg px-2 py-2 text-[11px] font-bold focus:border-red-500 outline-none" value={backupCfgDraft.targets?.remote?.user ||''} onChange={e => setBackupCfgDraft({...backupCfgDraft, targets: {...backupCfgDraft.targets, remote: {...(backupCfgDraft.targets?.remote || {}), user: e.target.value}}})} /> </div> </div> <div> <label className="text-[8px] font-black uppercase text-slate-400 dark:text-slate-500 ml-1">{ta.backupRemotePath}</label> <input type="text" placeholder="/var/backups/library" className="w-full bg-white dark:bg-[#1c1c1e] border border-slate-200 dark:border-white/10 rounded-lg px-2 py-2 text-[11px] font-bold focus:border-red-500 outline-none" value={backupCfgDraft.targets?.remote?.path ||''} onChange={e => setBackupCfgDraft({...backupCfgDraft, targets: {...backupCfgDraft.targets, remote: {...(backupCfgDraft.targets?.remote || {}), path: e.target.value}}})} /> </div> <div className="grid grid-cols-3 gap-2"> <div className="col-span-2"> <label className="text-[8px] font-black uppercase text-slate-400 dark:text-slate-500 ml-1">{ta.backupRemoteKeyPath}</label> <input type="text" placeholder="/root/.ssh/id_ed25519" className="w-full bg-white dark:bg-[#1c1c1e] border border-slate-200 dark:border-white/10 rounded-lg px-2 py-2 text-[11px] font-bold focus:border-red-500 outline-none" value={backupCfgDraft.targets?.remote?.sshKeyPath ||''} onChange={e => setBackupCfgDraft({...backupCfgDraft, targets: {...backupCfgDraft.targets, remote: {...(backupCfgDraft.targets?.remote || {}), sshKeyPath: e.target.value}}})} /> </div> <div> <label className="text-[8px] font-black uppercase text-slate-400 dark:text-slate-500 ml-1">{ta.backupRemotePort}</label> <input type="number" placeholder="22" className="w-full bg-white dark:bg-[#1c1c1e] border border-slate-200 dark:border-white/10 rounded-lg px-2 py-2 text-[11px] font-bold focus:border-red-500 outline-none" value={backupCfgDraft.targets?.remote?.port ?? 22} onChange={e => setBackupCfgDraft({...backupCfgDraft, targets: {...backupCfgDraft.targets, remote: {...(backupCfgDraft.targets?.remote || {}), port: parseInt(e.target.value) || 22}}})} /> </div> </div> </div> </div> {/* Target #3 — S3 (disabled by default) */} <div className="opacity-90"> <div className="flex items-center justify-between mb-3"> <p className="text-[8px] font-black uppercase text-red-600 tracking-widest flex items-center gap-2"> <Cloud size={11} /> {ta.backupTargetS3} <span className="text-slate-300">●</span> </p> <label className="relative inline-flex items-center cursor-pointer"> <input type="checkbox" className="sr-only peer" checked={!!backupCfgDraft.targets?.s3?.enabled} onChange={e => setBackupCfgDraft({...backupCfgDraft, targets: {...backupCfgDraft.targets, s3: {...(backupCfgDraft.targets?.s3 || {}), enabled: e.target.checked}}})} /> <div className="w-10 h-6 bg-slate-200 rounded-full peer peer-checked:bg-red-600 transition-all after:content-[''] after:absolute after:top-[3px] after:left-[3px] after:bg-white after:rounded-full after:h-[18px] after:w-[18px] after:transition-all peer-checked:after:translate-x-4" /> </label> </div> <p className="text-[10px] text-slate-400 dark:text-slate-500 leading-relaxed mb-3">{ta.backupS3Desc}</p> <div className="space-y-2 p-3 bg-slate-50 dark:bg-black/40 rounded-2xl border border-slate-100"> <div className="grid grid-cols-2 gap-2"> <div> <label className="text-[8px] font-black uppercase text-slate-400 ml-1">{ta.backupS3Endpoint}</label> <input type="text" placeholder="https://storage.yandexcloud.net" className="w-full bg-white border border-slate-200 dark:border-white/10 rounded-lg px-2 py-2 text-[11px] font-bold focus:border-red-500 outline-none" value={backupCfgDraft.targets?.s3?.endpoint ||''} onChange={e => setBackupCfgDraft({...backupCfgDraft, targets: {...backupCfgDraft.targets, s3: {...(backupCfgDraft.targets?.s3 || {}), endpoint: e.target.value}}})} /> </div> <div> <label className="text-[8px] font-black uppercase text-slate-400 dark:text-slate-500 ml-1">{ta.backupS3Region}</label> <input type="text" placeholder="ru-central1" className="w-full bg-white dark:bg-[#1c1c1e] border border-slate-200 dark:border-white/10 rounded-lg px-2 py-2 text-[11px] font-bold focus:border-red-500 outline-none" value={backupCfgDraft.targets?.s3?.region ||''} onChange={e => setBackupCfgDraft({...backupCfgDraft, targets: {...backupCfgDraft.targets, s3: {...(backupCfgDraft.targets?.s3 || {}), region: e.target.value}}})} /> </div> </div> <div className="grid grid-cols-2 gap-2"> <div> <label className="text-[8px] font-black uppercase text-slate-400 dark:text-slate-500 ml-1">{ta.backupS3Bucket}</label> <input type="text" placeholder="library-backups" className="w-full bg-white dark:bg-[#1c1c1e] border border-slate-200 dark:border-white/10 rounded-lg px-2 py-2 text-[11px] font-bold focus:border-red-500 outline-none" value={backupCfgDraft.targets?.s3?.bucket ||''} onChange={e => setBackupCfgDraft({...backupCfgDraft, targets: {...backupCfgDraft.targets, s3: {...(backupCfgDraft.targets?.s3 || {}), bucket: e.target.value}}})} /> </div> <div> <label className="text-[8px] font-black uppercase text-slate-400 dark:text-slate-500 ml-1">{ta.backupS3Prefix}</label> <input type="text" placeholder="prod/" className="w-full bg-white dark:bg-[#1c1c1e] border border-slate-200 dark:border-white/10 rounded-lg px-2 py-2 text-[11px] font-bold focus:border-red-500 outline-none" value={backupCfgDraft.targets?.s3?.prefix ||''} onChange={e => setBackupCfgDraft({...backupCfgDraft, targets: {...backupCfgDraft.targets, s3: {...(backupCfgDraft.targets?.s3 || {}), prefix: e.target.value}}})} /> </div> </div> <div> <label className="text-[8px] font-black uppercase text-slate-400 dark:text-slate-500 ml-1">{ta.backupS3AccessKey}</label> <input type="text" placeholder={backupCfgDraft.targets?.s3?.accessKey ==='***' ? ta.backupS3SecretSet : 'AKIA...'} className="w-full bg-white dark:bg-[#1c1c1e] border border-slate-200 dark:border-white/10 rounded-lg px-2 py-2 text-[11px] font-mono font-bold focus:border-red-500 outline-none" value={backupCfgDraft.targets?.s3?.accessKey ==='***' ? '' : (backupCfgDraft.targets?.s3?.accessKey || '')} onChange={e => setBackupCfgDraft({...backupCfgDraft, targets: {...backupCfgDraft.targets, s3: {...(backupCfgDraft.targets?.s3 || {}), accessKey: e.target.value}}})} /> </div> <div> <label className="text-[8px] font-black uppercase text-slate-400 dark:text-slate-500 ml-1">{ta.backupS3SecretKey}</label> <input type="password" placeholder={backupCfgDraft.targets?.s3?.secretKey ==='***' ? ta.backupS3SecretSet : '••••••••'} className="w-full bg-white dark:bg-[#1c1c1e] border border-slate-200 dark:border-white/10 rounded-lg px-2 py-2 text-[11px] font-mono font-bold focus:border-red-500 outline-none" value={backupCfgDraft.targets?.s3?.secretKey ==='***' ? '' : (backupCfgDraft.targets?.s3?.secretKey || '')} onChange={e => setBackupCfgDraft({...backupCfgDraft, targets: {...backupCfgDraft.targets, s3: {...(backupCfgDraft.targets?.s3 || {}), secretKey: e.target.value}}})} /> </div> </div> </div> <p className="text-[9px] text-slate-400 italic leading-relaxed">{ta.backupSecretsNotice}</p> </div> <div className="p-4 bg-slate-50 border-t border-slate-100 dark:border-white/[0.08] flex gap-3"> <button onClick={() => setShowBackupConfig(false)} className="flex-1 py-3 bg-slate-100 text-slate-600 rounded-2xl text-xs font-black uppercase tracking-widest hover:bg-slate-200 dark:hover:bg-white/10 transition-colors"> {ta.cancel} </button> <button onClick={saveBackupConfig} disabled={backupBusy} className="flex-1 py-3 bg-red-600 text-white rounded-2xl text-xs font-black uppercase tracking-widest shadow-md hover:bg-red-700 disabled:opacity-40 transition-colors"> {ta.save} </button> </div> </div> </div> )} {/* ── Delete confirmation modal ──────────────────────────────────────── */} {itemToDelete && ( <div className="fixed inset-0 z-[600] flex items-center justify-center p-6 bg-black/50 backdrop-blur-sm animate-in fade-in duration-200"> <div className="w-full max-w-sm bg-white dark:bg-[#1c1c1e] rounded-3xl shadow-2xl p-6 animate-in zoom-in-95 duration-200"> <div className="w-12 h-12 rounded-2xl bg-red-50 dark:bg-red-600/10 flex items-center justify-center mb-4"> <Trash2 size={22} className="text-red-600" /> </div> <h3 className="text-base font-black text-slate-900 dark:text-white mb-1">{ta.confirmDeleteItem}</h3> <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed mb-2">{ta.confirmDeleteItemDesc}</p> <p className="text-xs font-bold text-slate-700 dark:text-slate-200 truncate mb-6">«{typeof itemToDelete.title ==='object' ? (itemToDelete.title[lang] || itemToDelete.title.en || itemToDelete.title.ru) : itemToDelete.title}»</p>
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
