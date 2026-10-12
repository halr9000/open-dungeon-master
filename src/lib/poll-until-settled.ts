// Poll a changing server-side job until it reaches a terminal state. The
// callback owns presentation state; polling itself continues even when a
// pending response is identical to the previous one.
export function pollUntilSettled<T>(
  request: () => Promise<T>,
  isPending: (value: T) => boolean,
  onValue: (value: T) => void,
  intervalMs: number,
  limit: number,
): () => void {
  let stopped = false;
  let attempts = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const schedule = () => {
    if (!stopped && attempts < limit) {
      timer = setTimeout(poll, intervalMs);
    }
  };
  const poll = async () => {
    if (stopped || attempts >= limit) return;
    attempts += 1;
    try {
      const value = await request();
      if (stopped) return;
      onValue(value);
      if (isPending(value)) schedule();
    } catch {
      schedule();
    }
  };

  schedule();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
