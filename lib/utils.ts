import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function normalizeForMatch(s: string): string {
  return s
    .replace(/^[-=]{3,}$/gm, "")
    .replace(/^\s*>+\s?/gm, "")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*(?:\d+[.)]\s+|[-*+]\s+)/gm, "")
    .replace(/[–—]/g, "-")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[`*_~]/g, "")
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export class PrefixLogger {
  private prefix: string;
  private parent: PrefixLogger | null;

  constructor(prefix: string, parent: PrefixLogger | null = null) {
    this.prefix = prefix;
    this.parent = parent;
  }

  log(...args: any[]) {
    const timestamp = new Date().toISOString();
    const prefix = '[' + this.prefix + ']';

    if (this.parent) {
      this.parent.log(prefix, ...args);
    } else {
      console.log(timestamp, prefix, ...args);
    }
  }

  child(childPrefix: string): PrefixLogger {
    return new PrefixLogger(childPrefix, this);
  }
}
