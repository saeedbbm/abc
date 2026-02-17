import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
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
