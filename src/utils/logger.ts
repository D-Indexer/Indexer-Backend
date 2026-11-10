type LogLevel = 'debug' | 'info' | 'warn' | 'error';

type LogContext = Record<string, unknown>;

const LEVELS: Record<LogLevel | 'silent', number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

/** LOG_LEVEL is read directly (not via the env schema) so logging works before config is valid. */
function threshold(): number {
  const configured = (process.env.LOG_LEVEL ?? 'info').toLowerCase() as keyof typeof LEVELS;
  return LEVELS[configured] ?? LEVELS.info;
}

function serializeContext(context?: LogContext): string {
  if (!context || Object.keys(context).length === 0) return '';
  return ` ${JSON.stringify(context)}`;
}

function write(level: LogLevel, message: string, context?: LogContext): void {
  if (LEVELS[level] < threshold()) return;
  const line = `${new Date().toISOString()} ${level.toUpperCase()} ${message}${serializeContext(context)}`;

  if (level === 'error') {
    console.error(line);
    return;
  }

  if (level === 'warn') {
    console.warn(line);
    return;
  }

  console.log(line);
}

export const logger = {
  debug: (message: string, context?: LogContext) => write('debug', message, context),
  info: (message: string, context?: LogContext) => write('info', message, context),
  warn: (message: string, context?: LogContext) => write('warn', message, context),
  error: (message: string, context?: LogContext) => write('error', message, context),
};
