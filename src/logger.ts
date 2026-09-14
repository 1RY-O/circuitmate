export type LogLevel = "silent" | "error" | "warn" | "info" | "debug";

const LEVELS: Record<LogLevel, number> = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };

export function logLevelFromEnv(raw: string | undefined): LogLevel {
  const v = (raw ?? "info").toLowerCase();
  return v in LEVELS ? (v as LogLevel) : "info";
}

type Fields = Record<string, unknown>;

export class Logger {
  private readonly threshold: number;

  constructor(
    level: LogLevel = "info",
    private readonly out: { write(s: string): void } = process.stdout,
  ) {
    this.threshold = LEVELS[level];
  }

  private emit(level: LogLevel, fields: Fields): void {
    if (LEVELS[level] > this.threshold) return;
    this.out.write(JSON.stringify({ ts: new Date().toISOString(), level, ...fields }) + "\n");
  }

  debug(fields: Fields): void {
    this.emit("debug", fields);
  }

  info(fields: Fields): void {
    this.emit("info", fields);
  }

  warn(fields: Fields): void {
    this.emit("warn", fields);
  }

  error(fields: Fields): void {
    this.emit("error", fields);
  }

  access(fields: Fields): void {
    this.emit("info", { event: "http", ...fields });
  }
}