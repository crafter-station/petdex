"use client";

import { useEffect, useState } from "react";

import { Loader2, Volume2 } from "lucide-react";

import { Button } from "@/components/ui/button";

let activeAudio: HTMLAudioElement | null = null;
let activeToken: string | null = null;

export function PetSoundButton({
  soundUrl,
  displayName,
  labelPrefix = "Play sound for",
}: {
  soundUrl: string;
  displayName: string;
  labelPrefix?: string;
}) {
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

  async function handleClick(event: React.MouseEvent<HTMLElement>) {
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
    <Button
      type="button"
      variant={playing ? "cobalt" : "pearl"}
      size="icon-lg"
      onClick={handleClick}
      aria-label={`${labelPrefix} ${displayName}`}
      aria-pressed={playing}
      title={`${labelPrefix} ${displayName}`}
      className="rounded-xl"
    >
      {busy ? (
        <Loader2 className="size-4 animate-spin" />
      ) : (
        <Volume2 className="size-4" />
      )}
    </Button>
  );
}
