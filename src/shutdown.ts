/** Process-wide shutdown flag, shared by the entrypoint and readiness checks. */
let shuttingDown = false;

export function isShuttingDown(): boolean {
  return shuttingDown;
}

export function markShuttingDown(): void {
  shuttingDown = true;
}
