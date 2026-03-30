import { readdirSync, readFileSync, statSync } from "fs";
import path from "path";

type Finding = {
  file: string;
  line: number;
  label: string;
  snippet: string;
};

const ROOT = process.cwd();
const SCAN_ROOTS = [
  "app/api",
  "src/application/workers",
  "src/application/lib/kb2",
  "src/entities/models",
];

const ALLOWED_PATHS = [
  /^src[\\/]+application[\\/]+lib[\\/]+kb2[\\/]+step-judge(?:-configs)?\.ts$/i,
];

const FORBIDDEN_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  { label: "ground-truth reference", pattern: /ground-truth/i },
  { label: "benchmark reference", pattern: /\bbenchmarks\b/i },
  { label: "goal file reference", pattern: /goals[\\/]+goal\.txt/i },
  { label: "benchmark repo literal", pattern: /\bpawfinder-(web|api)\b/i },
  { label: "benchmark feature literal", pattern: /\bToy Donation Feature\b/i },
  {
    label: "benchmark convention literal",
    pattern: /\bKim's Color Convention\b|\bTim's Layout Convention\b|\bMatt's Client-Side Browse Pattern\b/i,
  },
  { label: "benchmark owner literal", pattern: /\b(?:Kim|Tim|Matt|Sarah Kim|Matt Chen)\b/ },
];

function shouldSkipFile(relativePath: string): boolean {
  if (!/\.(ts|tsx)$/i.test(relativePath)) return true;
  return ALLOWED_PATHS.some((pattern) => pattern.test(relativePath));
}

function walk(relativeDir: string): string[] {
  const absoluteDir = path.join(ROOT, relativeDir);
  const entries = readdirSync(absoluteDir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const nextRelative = path.join(relativeDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walk(nextRelative));
      continue;
    }
    files.push(nextRelative);
  }

  return files;
}

function collectFindings(relativePath: string): Finding[] {
  if (shouldSkipFile(relativePath)) return [];
  const absolutePath = path.join(ROOT, relativePath);
  if (!statSync(absolutePath).isFile()) return [];

  const lines = readFileSync(absolutePath, "utf-8").split(/\r?\n/);
  const findings: Finding[] = [];

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    for (const rule of FORBIDDEN_PATTERNS) {
      if (!rule.pattern.test(line)) continue;
      findings.push({
        file: relativePath.replace(/\\/g, "/"),
        line: index + 1,
        label: rule.label,
        snippet: line.trim(),
      });
    }
  }

  return findings;
}

function main(): void {
  const findings = SCAN_ROOTS
    .flatMap((relativeDir) => walk(relativeDir))
    .flatMap((relativePath) => collectFindings(relativePath));

  if (findings.length === 0) {
    console.log(JSON.stringify({
      ok: true,
      scanned_roots: SCAN_ROOTS,
      findings: [],
      summary: "No benchmark or ground-truth literals were found in runtime generation paths.",
    }, null, 2));
    return;
  }

  console.error(JSON.stringify({
    ok: false,
    scanned_roots: SCAN_ROOTS,
    findings,
    summary: "Benchmark or ground-truth references were found in runtime generation paths.",
  }, null, 2));
  process.exitCode = 1;
}

main();
