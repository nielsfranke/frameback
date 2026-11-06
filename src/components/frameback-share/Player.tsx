'use client'

/**
 * Frameback share view: lean video player with comment markers.
 * Uses the existing token stream URLs (/api/content/<token>); watermark vs. clean file is
 * decided server-side. Keyboard: Space/K play-pause, ←/→ 5 s, M mute, F fullscreen.
 */
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Maximize, Pause, Play, Volume2, VolumeX } from 'lucide-react'
import { formatSeconds } from './api'

export interface Marker {
  id: string
  seconds: number
  label: string
  count: number
  studio: boolean
}

export interface PlayerHandle {
  seek: (seconds: number) => void
  pause: () => void
  currentTime: () => number
}

interface Props {
  src: string
  poster?: string | null
  duration: number
  markers: Marker[]
  showPreviewBadge: boolean
  vertical?: boolean
  onTime?: (seconds: number) => void
  onMarker?: (commentId: string) => void
  /** Marker to highlight (e.g. the comment that was just clicked) */
  activeMarkerId?: string | null
}

const Player = forwardRef<PlayerHandle, Props>(function Player(
  { src, poster, duration: knownDuration, markers, showPreviewBadge, vertical, onTime, onMarker, activeMarkerId },
  ref
) {
  const t = useTranslations('fbShare')
  const video = useRef<HTMLVideoElement>(null)
  const frame = useRef<HTMLDivElement>(null)
  const [playing, setPlaying] = useState(false)
  const [muted, setMuted] = useState(false)
  const [time, setTime] = useState(0)
  const [duration, setDuration] = useState(knownDuration || 0)

  useImperativeHandle(ref, () => ({
    seek: (s) => { if (video.current) { video.current.currentTime = s; setTime(s) } },
    pause: () => video.current?.pause(),
    currentTime: () => video.current?.currentTime ?? 0,
  }))

  useEffect(() => { setTime(0); setPlaying(false) }, [src])

  const toggle = useCallback(() => {
    const v = video.current
    if (!v) return
    if (v.paused) void v.play().catch(() => {})
    else v.pause()
  }, [])

  const fullscreen = () => {
    const el = frame.current
    if (!el) return
    if (document.fullscreenElement) void document.exitFullscreen()
    else void el.requestFullscreen?.()
  }

  const seekBy = (delta: number) => {
    const v = video.current
    if (v) v.currentTime = Math.max(0, Math.min((v.duration || duration), v.currentTime + delta))
  }

  const onKey = (e: React.KeyboardEvent) => {
    // Buttons and text fields handle their own keys
    const tag = (e.target as HTMLElement).tagName
    if (tag === 'BUTTON' || tag === 'TEXTAREA' || tag === 'INPUT') return
    if (e.key === 'Home') { e.preventDefault(); if (video.current) video.current.currentTime = 0 }
    else if (e.key === 'End') { e.preventDefault(); if (video.current) video.current.currentTime = Math.max(0, (video.current.duration || duration) - 0.1) }
    else if (e.key === ' ' || e.key === 'k') { e.preventDefault(); toggle() }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); seekBy(-5) }
    else if (e.key === 'ArrowRight') { e.preventDefault(); seekBy(5) }
    else if (e.key === 'm') { setMuted((m) => !m) }
    else if (e.key === 'f') { fullscreen() }
  }

  const pct = duration > 0 ? (time / duration) * 100 : 0

  return (
    // The whole player (video + controls) goes fullscreen, so controls stay usable there
    <div ref={frame} onKeyDown={onKey} className="flex flex-col gap-3 [&:fullscreen]:bg-black [&:fullscreen]:p-4 [&:fullscreen]:text-white">
      <div
        className={`relative flex items-center justify-center overflow-hidden rounded-xl bg-black [:fullscreen_&]:max-h-none [:fullscreen_&]:flex-1 ${
          vertical
            // Portrait: real 9:16 frame, as large as the viewport allows, centered
            ? 'mx-auto aspect-[9/16] h-[min(52vh,calc((100vw-2rem)*16/9))] max-w-full md:h-[min(56vh,62rem)]'
            : 'aspect-video max-h-[62vh] w-full'
        }`}
      >
        <video
          ref={video}
          src={src || undefined}
          poster={poster || undefined}
          muted={muted}
          playsInline
          preload="metadata"
          className="h-full w-full object-contain"
          onClick={toggle}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onLoadedMetadata={(e) => setDuration(e.currentTarget.duration || knownDuration)}
          onTimeUpdate={(e) => { setTime(e.currentTarget.currentTime); onTime?.(e.currentTarget.currentTime) }}
        />
        {showPreviewBadge && (
          <span className="pointer-events-none absolute right-3 top-3 rounded-md bg-black/55 px-2 py-1 text-[11px] font-bold uppercase tracking-widest text-white/85">
            {t('previewBadge')}
          </span>
        )}
        {!playing && (
          <button
            type="button"
            onClick={toggle}
            aria-label={t('play')}
            className="absolute flex h-16 w-16 items-center justify-center rounded-full bg-black/60 text-white transition hover:bg-black/75 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
          >
            <Play className="ml-1 h-7 w-7 fill-current" />
          </button>
        )}
      </div>

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={toggle}
          aria-label={playing ? t('pause') : t('play')}
          className="flex h-10 w-10 flex-none items-center justify-center rounded-lg border bg-card hover:bg-muted"
        >
          {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
        </button>
        <span className="min-w-[88px] text-sm tabular-nums text-muted-foreground">
          {formatSeconds(time)} / {formatSeconds(duration)}
        </span>
        <div
          role="slider"
          tabIndex={0}
          aria-label={t('timeline')}
          aria-valuemin={0}
          aria-valuemax={Math.round(duration)}
          aria-valuenow={Math.round(time)}
          aria-valuetext={formatSeconds(time)}
          onClick={(e) => {
            if ((e.target as HTMLElement).closest('[data-marker]')) return
            const r = e.currentTarget.getBoundingClientRect()
            const s = ((e.clientX - r.left) / r.width) * duration
            if (video.current) video.current.currentTime = Math.max(0, Math.min(duration, s))
          }}
          className="relative h-11 flex-1 cursor-pointer rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
        >
          {/* track at the bottom, comment markers on their own row above it */}
          <div className="absolute inset-x-0 top-[31px] h-1 rounded-full bg-muted" />
          <div className="absolute left-0 top-[31px] h-1 rounded-full bg-primary" style={{ width: `${pct}%` }} />
          {markers.map((m) => {
            // Highlight the clicked marker and the one the playhead is currently on
            const active = m.id === activeMarkerId || Math.abs(time - m.seconds) < 0.5
            return (
            <button
              key={m.id}
              type="button"
              data-marker
              onClick={() => onMarker?.(m.id)}
              onKeyDown={(e) => e.stopPropagation()}
              title={m.label}
              aria-label={m.label}
              aria-pressed={active}
              className={`absolute top-0 -ml-[11px] flex h-[22px] w-[22px] items-center justify-center rounded-full border-2 text-[9px] font-bold text-white shadow-sm transition-transform before:absolute before:-inset-2 before:content-[''] ${m.studio ? 'bg-primary' : 'bg-violet-600'} ${active ? 'z-10 scale-125 border-white ring-2 ring-primary' : 'border-background'}`}
              style={{ left: `${duration > 0 ? (m.seconds / duration) * 100 : 0}%` }}
            >
              {m.count > 1 ? m.count : m.label.slice(0, 2)}
            </button>
            )
          })}
          <div className="absolute top-[25px] -ml-2 h-4 w-4 rounded-full bg-white shadow ring-4 ring-primary/20" style={{ left: `${pct}%` }} />
        </div>
        <button type="button" onClick={() => setMuted((m) => !m)} aria-label={muted ? t('unmute') : t('mute')} className="hidden h-10 w-10 items-center justify-center rounded-lg hover:bg-muted sm:flex">
          {muted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
        </button>
        <button type="button" onClick={fullscreen} aria-label={t('fullscreen')} className="flex h-10 w-10 items-center justify-center rounded-lg hover:bg-muted">
          <Maximize className="h-4 w-4" />
        </button>
      </div>
    </div>
  )
})

export default Player
