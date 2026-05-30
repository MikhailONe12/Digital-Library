import React from 'react';
import { captureError } from '../services/errorLog';

interface Props { children: React.ReactNode; }
interface State { hasError: boolean; message: string; }

// Catches render-time crashes anywhere below it, reports them to the built-in
// monitor, and shows a recoverable fallback instead of a blank white screen.
class ErrorBoundary extends React.Component<Props, State> {
  state: State = { hasError: false, message: '' };

  static getDerivedStateFromError(err: Error): State {
    return { hasError: true, message: err?.message || 'Unexpected error' };
  }

  componentDidCatch(err: Error, info: React.ErrorInfo) {
    captureError({
      kind: 'react',
      message: err?.message || 'React render error',
      stack: `${err?.stack || ''}\n--- componentStack ---${info?.componentStack || ''}`,
    });
  }

  render() {
    if (!this.state.hasError) return this.props.children;
    return (
      <div className="min-h-screen bg-white dark:bg-black flex flex-col items-center justify-center p-10 text-center">
        <div className="p-6 bg-red-50 dark:bg-red-600/10 rounded-full mb-6">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#dc2626" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
            <line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
        </div>
        <h1 className="text-xl font-black text-slate-900 dark:text-white uppercase tracking-tight mb-3">Что-то пошло не так</h1>
        <p className="text-xs font-bold text-slate-400 max-w-xs leading-relaxed mb-8 break-words">{this.state.message}</p>
        <button
          onClick={() => { this.setState({ hasError: false, message: '' }); location.reload(); }}
          className="px-6 py-3 bg-red-600 text-white rounded-2xl text-xs font-black uppercase tracking-widest shadow-md active:scale-95 transition-all hover:bg-red-700"
        >
          Перезагрузить
        </button>
      </div>
    );
  }
}

export default ErrorBoundary;
