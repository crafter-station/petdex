"use client";

import { useState, useTransition } from "react";

import { useTranslations } from "next-intl";

import { resubscribeAction, unsubscribeAction } from "./actions";

type Props = {
  token: string;
  email: string;
  initiallyUnsubscribed: boolean;
};

export function UnsubscribeForm({
  token,
  email,
  initiallyUnsubscribed,
}: Props) {
  const t = useTranslations("unsubscribePage.form");
  const [unsubscribed, setUnsubscribed] = useState(initiallyUnsubscribed);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function handleUnsubscribe() {
    setError(null);
    startTransition(async () => {
      try {
        const res = await unsubscribeAction(token);
        if (res.ok) setUnsubscribed(true);
        else setError(t("error"));
      } catch {
        // A rejected action (transport failure) would otherwise leave the
        // button re-enabled with no message at all.
        setError(t("error"));
      }
    });
  }

  function handleResubscribe() {
    setError(null);
    startTransition(async () => {
      try {
        const res = await resubscribeAction(token);
        if (res.ok) setUnsubscribed(false);
        else setError(t("error"));
      } catch {
        setError(t("error"));
      }
    });
  }

  return (
    <div className="space-y-5 rounded-2xl border border-border-base bg-surface/76 p-6 backdrop-blur">
      <div>
        <p className="font-mono text-xs tracking-[0.22em] text-muted-3 uppercase">
          {t("account")}
        </p>
        <p className="mt-1 break-all text-sm text-muted-1">{email}</p>
      </div>

      {unsubscribed ? (
        // role="status" so a screen reader hears the swap: the confirmation
        // replaces the button the user just activated, which otherwise drops
        // focus to the body and announces nothing.
        <div role="status" className="space-y-5">
          <div>
            <p className="text-base font-semibold">{t("unsubscribedTitle")}</p>
            <p className="mt-2 text-sm leading-6 text-muted-2">
              {t("unsubscribedBody")}
            </p>
          </div>
          <button
            type="button"
            onClick={handleResubscribe}
            disabled={pending}
            className="inline-flex h-11 items-center justify-center rounded-full border border-border-base bg-transparent px-5 text-sm font-medium transition hover:bg-surface disabled:opacity-50"
          >
            {pending ? t("working") : t("resubscribe")}
          </button>
        </div>
      ) : (
        <>
          <div>
            <p className="text-base font-semibold">{t("subscribedTitle")}</p>
            <p className="mt-2 text-sm leading-6 text-muted-2">
              {t("subscribedBody")}
            </p>
          </div>
          <button
            type="button"
            onClick={handleUnsubscribe}
            disabled={pending}
            className="inline-flex h-11 items-center justify-center rounded-full bg-inverse px-5 text-sm font-medium text-on-inverse transition hover:bg-inverse-hover disabled:opacity-50"
          >
            {pending ? t("working") : t("unsubscribe")}
          </button>
        </>
      )}

      {error ? (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
