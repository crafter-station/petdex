type TrackPayload = Record<string, unknown>;

export function track(_event: string, _payload?: TrackPayload): void {
  return;
}
