import * as dotenv from "dotenv";
import { resolve } from "path";

let envLoaded = false;

function ensureEnvLoaded(): void {
  if (envLoaded) return;
  dotenv.config({ path: resolve(process.cwd(), ".env") });
  envLoaded = true;
}

export function getServerEnv(name: string, fallbackNames: string[] = []): string {
  ensureEnvLoaded();

  for (const key of [name, ...fallbackNames]) {
    const value = process.env[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }

  throw new Error(`${name} not configured.`);
}

export function getOptionalServerEnv(name: string, fallbackNames: string[] = []): string | undefined {
  ensureEnvLoaded();

  for (const key of [name, ...fallbackNames]) {
    const value = process.env[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }

  return undefined;
}
