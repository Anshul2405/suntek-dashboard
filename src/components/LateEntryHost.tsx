import React, { useEffect, useState } from 'react';
import { bindLateEntryHost, submitLateRequest } from '../lib/opsControls';

/**
 * One dialog for the whole app. A backdated save calls ensureLateApproval,
 * which opens this and waits. Filing the request does not save the entry —
 * Management has to approve it first.
 */
export function LateEntryHost() {
  const [job, setJob] = useState<{
    module: string;
    entryDate: string;
    actorName: string;
    actorRole: string;
    bufferDays: number;
    resolve: (ok: boolean) => void;
  } | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    bindLateEntryHost((next) => {
      setReason('');
      setErr(null);
      setJob(next);
    });
    return () => bindLateEntryHost(null);
  }, []);

  if (!job) return null;

  function close(ok: boolean) {
    job?.resolve(ok);
    setJob(null);
  }

  async function send() {
    if (reason.trim().length < 8) {
      setErr('Write a short reason (at least a few words) so Management knows why this is late.');
      return;
    }
    setBusy(true);
    const error = await submitLateRequest({
      module: job!.module,
      entryDate: job!.entryDate,
      reason,
      actorName: job!.actorName,
      actorRole: job!.actorRole,
    });
    setBusy(false);
    if (error) { setErr(error); return; }
    close(false);
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.45)', zIndex: 80, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{ width: 'min(440px, 100%)', background: '#fff', borderRadius: 16, padding: 20, boxShadow: '0 20px 50px rgba(15,23,42,0.2)' }}>
        <div style={{ fontWeight: 800, fontSize: 16, color: '#0F172A' }}>Management approval needed</div>
        <p style={{ fontSize: 13, color: '#475569', marginTop: 8, lineHeight: 1.45 }}>
          {job.entryDate} is outside the {job.bufferDays}-day buffer for <strong>{job.module}</strong>. This entry will not be saved until Management approves the reason.
        </p>
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={3}
          placeholder="Why is this being entered late?"
          style={{ width: '100%', marginTop: 12, border: '1px solid #E2E8F0', borderRadius: 10, padding: 10, fontSize: 14, fontWeight: 600, fontFamily: 'inherit' }}
        />
        {err && <div style={{ color: '#DC2626', fontSize: 12, marginTop: 8 }}>{err}</div>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
          <button type="button" onClick={() => close(false)} style={{ border: '1px solid #E2E8F0', background: '#fff', borderRadius: 10, padding: '8px 12px', fontWeight: 700, cursor: 'pointer' }}>Cancel</button>
          <button type="button" disabled={busy} onClick={() => void send()} style={{ border: 'none', background: '#161616', color: '#fff', borderRadius: 10, padding: '8px 12px', fontWeight: 700, cursor: 'pointer' }}>
            {busy ? 'Sending…' : 'Request permission'}
          </button>
        </div>
      </div>
    </div>
  );
}
