import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

function loadDotEnvFile() {
  const envPath = path.join(projectRoot, ".env");
  try {
    const content = fsSync.readFileSync(envPath, "utf8");
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
      const index = trimmed.indexOf("=");
      const key = trimmed.slice(0, index).trim();
      let value = trimmed.slice(index + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (key && process.env[key] === undefined) process.env[key] = value;
    }
  } catch {}
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", ...options });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with code ${code}`));
    });
  });
}

loadDotEnvFile();

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required for db:backup");
  process.exit(1);
}

const backupDir = process.env.POSTWAVE_BACKUP_DIR || path.join(projectRoot, "backups");
await fs.mkdir(backupDir, { recursive: true });

const output = path.join(backupDir, `postwave-${timestamp()}.dump`);
const pgDumpBin = process.env.PG_DUMP_PATH || "pg_dump";

await run(pgDumpBin, [
  "--format=custom",
  "--no-owner",
  "--no-acl",
  "--file",
  output,
  process.env.DATABASE_URL
]);

console.log(`Database backup written to ${output}`);
