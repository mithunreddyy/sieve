/** Tiny argument helpers shared by the newer commands. Both remove what they read from `args`. */
export function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const v = args[i + 1];
  args.splice(i, v === undefined || v.startsWith("--") ? 1 : 2);
  return v === undefined || v.startsWith("--") ? "" : v;
}

export function has(args: string[], name: string): boolean {
  const i = args.indexOf(name);
  if (i === -1) return false;
  args.splice(i, 1);
  return true;
}
