import React, { useEffect, useRef, useState, useCallback } from 'react';
import { X, SwitchCamera, Camera, RotateCcw, Check, ImageUp } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { ButtonV2 } from './v2';
import { retainPhoto } from '../lib/photoCheck';

type Facing = 'environment' | 'user';
type CamState = 'starting' | 'live' | 'preview' | 'fallback' | 'error';

/**
 * In-app camera modal — opens a live viewfinder (getUserMedia) with a
 * front/back flip button, captures to JPEG, and shows a confirm/retake
 * preview before handing the blob back. Falls back to the native file
 * input (`capture` attr → OS camera on phones) when getUserMedia is
 * unavailable or denied (e.g. plain-HTTP LAN access), so the flow never
 * dead-ends.
 */
export function CameraCapture({
  open,
  onClose,
  onCapture,
  title,
  initialFacing = 'environment',
}: {
  open: boolean;
  onClose: () => void;
  /** Called with the confirmed photo. The modal closes itself afterwards. */
  onCapture: (blob: Blob) => void;
  title?: string;
  /** 'environment' = back camera (default), 'user' = selfie. */
  initialFacing?: Facing;
}) {
  const { t } = useTranslation();
  const heading = title ?? t('checkin.takePhoto', 'Take photo');
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const galleryRef = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<CamState>('starting');
  const [facing, setFacing] = useState<Facing>(initialFacing);
  const [shot, setShot] = useState<{ blob: Blob; url: string } | null>(null);

  const stopStream = useCallback(() => {
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
  }, []);

  const startStream = useCallback(async (face: Facing) => {
    stopStream();
    setState('starting');
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('no getUserMedia');
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: face, width: { ideal: 1280 }, height: { ideal: 960 } },
        audio: false,
      });
      streamRef.current = stream;
      setState('live');
    } catch (err) {
      // Blocked/unsupported → native input (mobile opens the OS camera via `capture`).
      console.warn('[CameraCapture] getUserMedia failed → file-input fallback:', err);
      setState('fallback');
    }
  }, [stopStream]);

  // Open/close lifecycle.
  useEffect(() => {
    if (open) {
      setShot(null);
      startStream(facing);
    } else {
      stopStream();
      setShot(s => { if (s) URL.revokeObjectURL(s.url); return null; });
    }
    return stopStream;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Attach the stream once the <video> is mounted.
  useEffect(() => {
    if (state === 'live' && videoRef.current && streamRef.current) {
      videoRef.current.srcObject = streamRef.current;
      videoRef.current.play().catch(() => {});
    }
  }, [state]);

  if (!open) return null;

  function flip() {
    const next: Facing = facing === 'environment' ? 'user' : 'environment';
    setFacing(next);
    startStream(next);
  }

  function snap() {
    const video = videoRef.current, canvas = canvasRef.current;
    if (!video || !canvas || !video.videoWidth) return;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(video, 0, 0);
    canvas.toBlob(b => {
      if (!b) return;
      setShot({ blob: b, url: URL.createObjectURL(b) });
      setState('preview');
      stopStream();
    }, 'image/jpeg', 0.85);
  }

  function confirmPhoto() {
    if (!shot) return;
    onCapture(shot.blob);
    onClose();
  }

  function retake() {
    setShot(s => { if (s) URL.revokeObjectURL(s.url); return null; });
    startStream(facing);
  }

  function onFile(f: File | undefined) {
    if (!f) return;
    // Copy starts before the input is cleared below. Gallery photos on plant
    // phones are often HEIC, or the original file goes blank once the picker closes.
    const pending = retainPhoto(f, f.name);
    void pending.then((blob) => {
      setShot({ blob, url: URL.createObjectURL(blob) });
      setState('preview');
    }).catch(() => {
      setState('error');
    });
  }

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center p-4 bg-slate-900/70 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="bg-white w-full max-w-md rounded-2xl shadow-2xl overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-100">
          <div className="font-heading font-semibold text-[15px]">{heading}</div>
          <button onClick={onClose} aria-label="Close" className="text-slate-400 hover:text-slate-600 p-1 -mr-1"><X size={16} /></button>
        </div>

        {/* Viewfinder / preview area */}
        <div className="relative bg-slate-900 aspect-[4/3] flex items-center justify-center">
          {state === 'starting' && (
            <div className="text-slate-300 text-[13px] flex flex-col items-center gap-2">
              <div className="w-6 h-6 rounded-full border-2 border-slate-600 border-t-white animate-spin" />
              {t('checkin.startingCamera', 'Starting camera…')}
            </div>
          )}
          {state === 'live' && (
            <video
              ref={videoRef}
              playsInline
              muted
              className="w-full h-full object-cover"
              // Mirror the selfie preview only — the captured photo stays true.
              style={facing === 'user' ? { transform: 'scaleX(-1)' } : undefined}
            />
          )}
          {state === 'preview' && shot && (
            <img src={shot.url} alt="Captured" className="w-full h-full object-contain" />
          )}
          {state === 'error' && (
            <div className="text-center px-6">
              <div className="text-slate-200 text-[13px] font-medium">{t('checkin.photoUnreadable', 'That photo could not be opened.')}</div>
              <div className="text-slate-400 text-[11.5px] mt-1">{t('checkin.photoUnreadableHint', 'Take it with the Capture button, or pick a JPG from the gallery.')}</div>
            </div>
          )}
          {state === 'fallback' && (
            <div className="text-center px-6">
              <Camera size={28} className="text-slate-500 mx-auto mb-2" />
              <div className="text-slate-200 text-[13px] font-medium">{t('checkin.previewUnavailable', 'Camera preview unavailable here')}</div>
              <div className="text-slate-400 text-[11.5px] mt-1 mb-4">{t('checkin.previewUnavailableHint', 'On phones this opens the camera app directly.')}</div>
              <ButtonV2 variant="accent" icon={<ImageUp />} onClick={() => fileRef.current?.click()}>
                {t('checkin.openCameraOrChoose', 'Open camera / choose photo')}
              </ButtonV2>
              <input
                ref={fileRef} type="file" accept="image/*" className="hidden"
                onChange={e => { onFile(e.target.files?.[0]); e.target.value = ''; }}
              />
            </div>
          )}
          <canvas ref={canvasRef} className="hidden" />
        </div>

        {/* Controls */}
        <div className="flex items-center justify-between gap-2 px-4 py-3">
          {state === 'preview' ? (
            <>
              <ButtonV2 variant="outline" icon={<RotateCcw />} onClick={retake}>{t('checkin.retake', 'Retake')}</ButtonV2>
              <ButtonV2 variant="primary" icon={<Check />} onClick={confirmPhoto}>{t('checkin.usePhoto', 'Use photo')}</ButtonV2>
            </>
          ) : (
            <>
              <ButtonV2
                variant="outline" icon={<SwitchCamera />} onClick={flip}
                disabled={state !== 'live'}
                title={facing === 'environment' ? t('checkin.switchToFrontCamera', 'Switch to front camera') : t('checkin.switchToBackCamera', 'Switch to back camera')}
              >
                {facing === 'environment' ? t('checkin.cameraFront', 'Front') : t('checkin.cameraBack', 'Back')}
              </ButtonV2>
              <ButtonV2 variant="accent" icon={<Camera />} onClick={snap} disabled={state !== 'live'}>
                {t('checkin.capture', 'Capture')}
              </ButtonV2>
              <ButtonV2 variant="outline" icon={<ImageUp />} onClick={() => galleryRef.current?.click()}>
                {t('checkin.chooseFromGallery', 'Choose from gallery')}
              </ButtonV2>
            </>
          )}
        </div>
        <input
          ref={galleryRef} type="file" accept="image/*" className="hidden"
          onChange={e => { onFile(e.target.files?.[0]); e.target.value = ''; }}
        />
      </div>
    </div>
  );
}
