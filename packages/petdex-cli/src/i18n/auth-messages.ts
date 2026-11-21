/**
 * Terminal-facing copy for the CLI auth flow.
 *
 * Only messages this module actually emits are here. The rest of the CLI's
 * output is still English; localizing all of it is a separate pass. Keeping
 * the table small means it stays reviewable against the page strings in
 * `cli-auth/lib/callback-page.ts`, which cover the same failures for the
 * browser.
 */

import { type CliLocale, resolveCliLocale } from "./locale";

type AuthMessages = {
  /** Browser-facing page copy lives in callback-page.ts; these are terminal. */
  callbackTimeout: (ms: number) => string;
  callbackClosed: string;
  tokenRequestFailed: (detail: string) => string;
  tokenRequestHttp: (status: number) => string;
  userinfoRequestFailed: (detail: string) => string;
  userinfoRequestHttp: (status: number) => string;
};

const MESSAGES: Record<CliLocale, AuthMessages> = {
  en: {
    callbackTimeout: (ms) => `OAuth callback timed out after ${ms}ms.`,
    callbackClosed: "OAuth callback server was closed.",
    tokenRequestFailed: (detail) => `Token request failed: ${detail}`,
    tokenRequestHttp: (status) => `Token request failed with HTTP ${status}.`,
    userinfoRequestFailed: (detail) => `Userinfo request failed: ${detail}`,
    userinfoRequestHttp: (status) =>
      `Userinfo request failed with HTTP ${status}.`,
  },
  es: {
    callbackTimeout: (ms) =>
      `El callback de OAuth agotó el tiempo tras ${ms}ms.`,
    callbackClosed: "Se cerró el servidor de callback de OAuth.",
    tokenRequestFailed: (detail) => `Falló la petición de token: ${detail}`,
    tokenRequestHttp: (status) =>
      `La petición de token falló con HTTP ${status}.`,
    userinfoRequestFailed: (detail) =>
      `Falló la petición de userinfo: ${detail}`,
    userinfoRequestHttp: (status) =>
      `La petición de userinfo falló con HTTP ${status}.`,
  },
  zh: {
    callbackTimeout: (ms) => `OAuth 回调在 ${ms}ms 后超时。`,
    callbackClosed: "OAuth 回调服务器已关闭。",
    tokenRequestFailed: (detail) => `令牌请求失败：${detail}`,
    tokenRequestHttp: (status) => `令牌请求失败，HTTP ${status}。`,
    userinfoRequestFailed: (detail) => `用户信息请求失败：${detail}`,
    userinfoRequestHttp: (status) => `用户信息请求失败，HTTP ${status}。`,
  },
};

/**
 * Copy for the current locale.
 *
 * `resolveCliLocale` is called per lookup rather than cached: the CLI is a
 * short-lived process, and a test that sets `LANG` must not be defeated by
 * a value read at import time.
 */
export function authMessages(env?: NodeJS.ProcessEnv): AuthMessages {
  return MESSAGES[resolveCliLocale(env)];
}

/** Exposed for the key-parity test. */
export function authMessagesByLocale(): Record<CliLocale, AuthMessages> {
  return MESSAGES;
}
