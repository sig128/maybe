import pino from "pino";

/** Structured logs with secrets and signatures redacted at the source. */
export const log = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { service: "maybe" },
  redact: {
    paths: ["*.authorization", "*.cookie", "*.secret", "*.secretKey", "*.privateKey", "*.apiKey", "*.token", "*.session", "*.signature", "req.headers.authorization", "headers.authorization"],
    censor: "[redacted]",
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});

export function shortAddr(a: string | null | undefined): string {
  return a ? `${a.slice(0, 4)}…${a.slice(-4)}` : "";
}
