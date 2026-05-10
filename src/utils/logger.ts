/**
 * IronShield Structured Logger
 * Winston-based logging with hourly rotation and color-coded output
 */
import winston from "winston";
import path from "path";
import fs from "fs";
import { LOGGING } from "../config/config";

// Ensure log directory exists
if (!fs.existsSync(LOGGING.DIR)) {
  fs.mkdirSync(LOGGING.DIR, { recursive: true });
}

// ── Custom Format ────────────────────────────────────────────
const ironShieldFormat = winston.format.printf(
  ({ level, message, timestamp, module, ...meta }) => {
    const mod = module ? `[${module}]` : "[CORE]";
    const metaStr = Object.keys(meta).length
      ? `\n  └─ ${JSON.stringify(meta, null, 0)}`
      : "";
    return `${timestamp} ${level.toUpperCase().padEnd(7)} ${mod.padEnd(16)} ${message}${metaStr}`;
  }
);

// ── Logger Instance ──────────────────────────────────────────
const logger = winston.createLogger({
  level: LOGGING.LEVEL,
  format: winston.format.combine(
    winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss.SSS" }),
    winston.format.errors({ stack: true }),
    ironShieldFormat
  ),
  transports: [
    // Console output with colors
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.timestamp({ format: "HH:mm:ss.SSS" }),
        winston.format.colorize(),
        ironShieldFormat
      ),
    }),

    // Combined log file
    new winston.transports.File({
      filename: path.join(LOGGING.DIR, "ironshield.log"),
      maxsize: 10 * 1024 * 1024, // 10MB
      maxFiles: LOGGING.MAX_FILES,
    }),

    // Error-only log
    new winston.transports.File({
      filename: path.join(LOGGING.DIR, "errors.log"),
      level: "error",
      maxsize: 10 * 1024 * 1024,
      maxFiles: 10,
    }),

    // Profit tracking log
    new winston.transports.File({
      filename: path.join(LOGGING.DIR, "profits.log"),
      level: "info",
      maxsize: 10 * 1024 * 1024,
      maxFiles: 30,
    }),
  ],
});

// ── Module-Specific Loggers ──────────────────────────────────
export function createModuleLogger(moduleName: string) {
  return {
    info: (message: string, meta?: Record<string, unknown>) =>
      logger.info(message, { module: moduleName, ...meta }),
    warn: (message: string, meta?: Record<string, unknown>) =>
      logger.warn(message, { module: moduleName, ...meta }),
    error: (message: string, meta?: Record<string, unknown>) =>
      logger.error(message, { module: moduleName, ...meta }),
    debug: (message: string, meta?: Record<string, unknown>) =>
      logger.debug(message, { module: moduleName, ...meta }),
    profit: (message: string, meta?: Record<string, unknown>) =>
      logger.info(`💰 ${message}`, { module: "PROFIT", ...meta }),
  };
}

// ── Hourly Log Backup ────────────────────────────────────────
export function createHourlyBackup(): void {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupDir = path.join(LOGGING.DIR, "backups");

  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true });
  }

  const logFile = path.join(LOGGING.DIR, "ironshield.log");
  if (fs.existsSync(logFile)) {
    const backupFile = path.join(backupDir, `ironshield-${timestamp}.log`);
    fs.copyFileSync(logFile, backupFile);
    logger.info(`📁 Hourly backup created: ${backupFile}`, { module: "LOGGER" });
  }
}

export default logger;
