export function createTrailingCoalescer(run: () => void, waitMs: number) {
  let timer: ReturnType<typeof setTimeout> | null = null;

  return {
    call() {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        run();
      }, waitMs);
    },
    cancel() {
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}
