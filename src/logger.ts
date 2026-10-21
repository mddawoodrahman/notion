import pino from "pino";

const redactPaths = [
  "NOTION_API_KEY",
  "NOTION_WEBHOOK_VERIFICATION_TOKEN",
  "DATABASE_URL",
  "DIRECT_DATABASE_URL",
  "TEST_DATABASE_URL",
  "headers.authorization",
  "headers.Authorization",
  "headers['x-notion-signature']",
  "headers['X-Notion-Signature']",
  "req.headers.authorization",
  "req.headers['x-notion-signature']",
  "password",
  "*.password",
  "token",
  "*.token",
  "verification_token",
  "payload.verification_token",
];

export const logger = pino({
  level: process.env.LOG_LEVEL || (process.env.NODE_ENV === "test" ? "silent" : "info"),
  redact: {
    paths: redactPaths,
    censor: "[REDACTED]",
  },
  serializers: {
    err: pino.stdSerializers.err,
    req: pino.stdSerializers.req,
    res: pino.stdSerializers.res,
  },
});
