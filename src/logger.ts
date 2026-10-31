import pino from "pino";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  redact: {
    paths: ["*.secretKey", "*.SPONSOR_SECRET_KEY", "req.headers.authorization"],
    censor: "[redacted]",
  },
  transport:
    process.env.NODE_ENV === "development"
      ? { target: "pino-pretty", options: { colorize: true } }
      : undefined,
});

export type Logger = typeof logger;
