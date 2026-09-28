const DRY_RUN_TRUE = new Set(["--dry-run", "--dry-run=true"]);
const DRY_RUN_FALSE = new Set(["--no-dry-run", "--dry-run=false"]);

export function readDryRunFlag(argv: string[] = process.argv.slice(2)): boolean | undefined {
  let value: boolean | undefined;

  for (const arg of argv) {
    if (DRY_RUN_TRUE.has(arg)) {
      value = true;
      continue;
    }

    if (DRY_RUN_FALSE.has(arg)) {
      value = false;
      continue;
    }

    if (arg.startsWith("--dry-run=")) {
      throw new Error(`无效的参数: ${arg}。请使用 --dry-run、--dry-run=true、--dry-run=false 或 --no-dry-run。`);
    }
  }

  return value;
}

export function commandAndPositionals(argv: string[] = process.argv.slice(2)): { command: string; positionals: string[] } {
  const tokens = argv.filter((arg) => arg !== "--" && !arg.startsWith("-"));
  return {
    command: tokens[0] ?? "run",
    positionals: tokens.slice(1),
  };
}
