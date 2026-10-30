import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Mic, X } from 'lucide-react';
import { useRoleContext } from '../../contexts/RoleContext';
import { useSearchPalette } from '../../contexts/SearchPaletteContext';
import { profileCanAccess } from '../../lib/profiles';
import { matchVoiceRoute } from '../../lib/voiceRoutes';

type Phase = 'listening' | 'review' | 'error';
const COUNTDOWN = 3; // seconds shown before the search fires (cancel window)

// Web Speech API isn't in the standard TS lib.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const SpeechRecognitionImpl: any = typeof window !== 'undefined' ? (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition : null;

/**
 * Voice search overlay. Tap the mic → speak → live transcription appears → a
 * short countdown (cancellable) → it routes you to the matching section or opens
 * the quick-search palette pre-filled with what you said. Uses the browser's
 * built-in speech recognition (no key, no backend); language follows the UI.
 */
export function VoiceSearch({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { activeProfile } = useRoleContext();
  const { openPalette } = useSearchPalette();

  const [phase, setPhase] = useState<Phase>('listening');
  const [transcript, setTranscript] = useState('');
  const [error, setError] = useState('');
  const [count, setCount] = useState(COUNTDOWN);
  const [restartKey, setRestartKey] = useState(0);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const recRef = useRef<any>(null);
  const transcriptRef = useRef('');
  const tickRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

  function cleanup() {
    clearInterval(tickRef.current);
    try { recRef.current?.abort?.(); } catch { /* ignore */ }
    recRef.current = null;
  }

  function close() {
    cleanup();
    onClose();
  }

  function execute(text: string) {
    cleanup();
    onClose();
    const q = text.trim();
    const route = matchVoiceRoute(q);
    if (route && profileCanAccess(activeProfile, route.split('?')[0])) navigate(route);
    else openPalette(q);
  }

  // Start recognition when the overlay opens.
  useEffect(() => {
    if (!open) return;
    setTranscript('');
    transcriptRef.current = '';
    setError('');
    setCount(COUNTDOWN);

    if (!SpeechRecognitionImpl) {
      setPhase('error');
      setError(t('voice.notSupported'));
      return;
    }

    setPhase('listening');
    const rec = new SpeechRecognitionImpl();
    rec.lang = i18n.language?.startsWith('hi') ? 'hi-IN' : 'en-IN';
    rec.interimResults = true;
    rec.continuous = false;
    rec.maxAlternatives = 1;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    rec.onresult = (e: any) => {
      let interim = '';
      let final = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) final += r[0].transcript;
        else interim += r[0].transcript;
      }
      if (final) transcriptRef.current = (transcriptRef.current + ' ' + final).trim();
      setTranscript((transcriptRef.current + ' ' + interim).trim());
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    rec.onerror = (e: any) => {
      if (e?.error === 'no-speech') { setPhase('error'); setError(t('voice.didntCatch')); return; }
      if (e?.error === 'not-allowed' || e?.error === 'service-not-allowed') { setPhase('error'); setError(t('voice.micDenied')); return; }
      setPhase('error'); setError(t('voice.didntCatch'));
    };
    rec.onend = () => {
      const text = transcriptRef.current.trim();
      if (!text) { setPhase((p) => (p === 'error' ? p : 'error')); setError((er) => er || t('voice.didntCatch')); return; }
      setTranscript(text);
      setPhase('review');
    };

    recRef.current = rec;
    try { rec.start(); } catch { /* already started */ }
    return () => cleanup();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, restartKey]);

  // Countdown once we have a final transcript, then fire the search.
  useEffect(() => {
    if (!open || phase !== 'review') return;
    setCount(COUNTDOWN);
    tickRef.current = setInterval(() => {
      setCount((c) => {
        if (c <= 1) { clearInterval(tickRef.current); execute(transcriptRef.current); return 0; }
        return c - 1;
      });
    }, 1000);
    return () => clearInterval(tickRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, open]);

  if (!open) return null;

  return createPortal(
    <div
      onMouseDown={close}
      style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.55)', zIndex: 500, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}
    >
      <div
        onMouseDown={(e) => e.stopPropagation()}
        style={{ width: '100%', maxWidth: 420, background: '#fff', borderRadius: 24, boxShadow: '0 24px 70px rgba(0,0,0,0.30)', padding: '28px 24px', textAlign: 'center', position: 'relative' }}
      >
        {/* Close */}
        <button onClick={close} aria-label={t('voice.cancel')} style={{ position: 'absolute', top: 14, right: 14, width: 32, height: 32, borderRadius: '50%', border: 'none', background: '#F1F5F9', color: '#64748B', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <X size={16} />
        </button>

        {/* Mic / status orb */}
        <div style={{ position: 'relative', width: 84, height: 84, margin: '6px auto 18px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          {phase === 'listening' && (
            <>
              <span className="animate-ping" style={{ position: 'absolute', inset: 0, borderRadius: '50%', background: '#F47651', opacity: 0.25 }} />
              <span className="animate-pulse" style={{ position: 'absolute', inset: 8, borderRadius: '50%', background: '#F47651', opacity: 0.2 }} />
            </>
          )}
          <div style={{
            width: 64, height: 64, borderRadius: '50%', position: 'relative',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: phase === 'error' ? '#FEE2E2' : phase === 'review' ? '#0F172A' : 'linear-gradient(135deg,#F47651,#ea580c)',
            color: phase === 'error' ? '#DC2626' : '#fff',
          }}>
            {phase === 'review'
              ? <span style={{ fontSize: 20, fontWeight: 800 }}>{count}</span>
              : <Mic size={26} />}
          </div>
        </div>

        {/* Status line */}
        <div style={{ fontSize: 13, fontWeight: 600, color: '#64748B', marginBottom: 6 }}>
          {phase === 'listening' && t('voice.listening')}
          {phase === 'review' && t('voice.searchingIn', { n: count })}
          {phase === 'error' && t('voice.heading')}
        </div>

        {/* Transcript / hint / error */}
        <div style={{ fontSize: 18, fontWeight: 700, color: '#0F172A', minHeight: 28, lineHeight: 1.35, marginBottom: 18 }}>
          {phase === 'error' ? error : (transcript || <span style={{ color: '#CBD5E1', fontWeight: 500, fontSize: 14 }}>{t('voice.speakNow')}</span>)}
        </div>

        {/* Actions */}
        <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
          <button onClick={close} style={{ flex: 1, padding: '11px 0', borderRadius: 24, border: '1px solid #E2E8F0', background: '#F8FAFC', fontSize: 13, fontWeight: 600, color: '#475569', cursor: 'pointer', fontFamily: 'inherit' }}>
            {t('voice.cancel')}
          </button>
          {phase === 'review' && (
            <button onClick={() => execute(transcriptRef.current)} style={{ flex: 2, padding: '11px 0', borderRadius: 24, border: 'none', background: '#F47651', fontSize: 13, fontWeight: 700, color: '#fff', cursor: 'pointer', fontFamily: 'inherit' }}>
              {t('voice.searchNow')}
            </button>
          )}
          {phase === 'error' && SpeechRecognitionImpl && (
            <button onClick={() => setRestartKey((k) => k + 1)} style={{ flex: 2, padding: '11px 0', borderRadius: 24, border: 'none', background: '#0F172A', fontSize: 13, fontWeight: 700, color: '#fff', cursor: 'pointer', fontFamily: 'inherit' }}>
              {t('voice.tryAgain')}
            </button>
          )}
          {phase === 'error' && !SpeechRecognitionImpl && (
            <button onClick={() => { close(); openPalette(''); }} style={{ flex: 2, padding: '11px 0', borderRadius: 24, border: 'none', background: '#0F172A', fontSize: 13, fontWeight: 700, color: '#fff', cursor: 'pointer', fontFamily: 'inherit' }}>
              {t('voice.typeInstead')}
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
