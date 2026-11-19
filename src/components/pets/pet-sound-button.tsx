"use client";

import { useEffect, useState } from "react";

import { Loader2, Volume2 } from "lucide-react";
import { useTranslations } from "next-intl";

let activeAudio: HTMLAudioElement | null = null;
let activeToken: string | null = null;

export function PetSoundButton({
  soundUrl,
  displayName,
}: {
  soundUrl: string;
  displayName: string;
}) {
  const t = useTranslations("gallery");
  // Always the localized default. A `labelPrefix` prop used to let a caller
  // override this, and `pets/[slug]` passed a hardcoded English string — so
  // the aria-label and title announced English on /zh and /es. No caller may
  // inject an untranslated phrase now.
  const label = t("playSoundFor", { name: displayName });
  const [playing, setPlaying] = useState(false);
  const [busy, setBusy] = useState(false);
  const token = soundUrl;

  useEffect(() => {
    return () => {
      if (activeToken === token && activeAudio) {
        activeAudio.pause();
        activeAudio.currentTime = 0;
        activeAudio = null;
        activeToken = null;
      }
    };
  }, [token]);

  async function handleClick(event: React.MouseEvent<HTMLButtonElement>) {
    event.preventDefault();
    event.stopPropagation();

    if (busy) return;

    if (activeToken === token && activeAudio) {
      activeAudio.pause();
      activeAudio.currentTime = 0;
      activeAudio = null;
      activeToken = null;
      setPlaying(false);
      return;
    }

    if (activeAudio) {
      activeAudio.pause();
      activeAudio.currentTime = 0;
      activeAudio = null;
      activeToken = null;
    }

    const audio = new Audio(soundUrl);
    activeAudio = audio;
    activeToken = token;
    setBusy(true);

    audio.onended = () => {
      if (activeToken === token) {
        activeAudio = null;
        activeToken = null;
      }
      setPlaying(false);
    };

    audio.onpause = () => {
      if (audio.currentTime === 0) {
        setPlaying(false);
      }
    };

    // A load or decode failure fires `error`, not a rejected `play()`: the
    // play promise has already resolved by then, so without this the button
    // stayed lit as "playing" over a pet whose sound never loads (a stale
    // soundUrl, or the R2 object gone).
    audio.onerror = () => {
      if (activeToken === token) {
        activeAudio = null;
        activeToken = null;
      }
      setPlaying(false);
    };

    try {
      await audio.play();
      setPlaying(true);
    } catch {
      if (activeToken === token) {
        activeAudio = null;
        activeToken = null;
      }
      setPlaying(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      aria-label={label}
      title={label}
      className={`inline-flex size-9 items-center justify-center rounded-full border backdrop-blur transition ${
        playing
          ? "border-brand/30 bg-brand/15 text-brand"
          : "border-border-base bg-surface/70 text-muted-2 hover:bg-surface-muted hover:text-foreground"
      }`}
    >
      {busy ? (
        <Loader2 className="size-4 animate-spin" />
      ) : (
        <Volume2 className="size-4" />
      )}
    </button>
  );
}
