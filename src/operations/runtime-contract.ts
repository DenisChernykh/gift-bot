export type PackageContract = {
  engines?: { node?: string; pnpm?: string };
  packageManager?: string;
};

type VersionTuple = [number, number, number];

function tuple(value: string): VersionTuple {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value.trim().replace(/^v/, ''));
  if (!match) throw new Error('Invalid runtime version');
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compare(left: VersionTuple, right: VersionTuple): number {
  return left[0] - right[0] || left[1] - right[1] || left[2] - right[2];
}

function satisfies(value: string, range: string): boolean {
  const match = /^>=(\d+\.\d+\.\d+) <(\d+)(?:\.0\.0)?$/.exec(range);
  if (!match) throw new Error(`Unsupported runtime range: ${range}`);
  const current = tuple(value);
  return (
    compare(current, tuple(match[1])) >= 0 && current[0] < Number(match[2])
  );
}

export function assertRuntimeContract(input: {
  packageJson: PackageContract;
  nodeVersion: string;
  pnpmVersion: string;
}): void {
  const nodeRange = input.packageJson.engines?.node;
  const pnpmRange = input.packageJson.engines?.pnpm;
  const packageManager = input.packageJson.packageManager;
  if (!nodeRange || !pnpmRange || packageManager !== 'pnpm@11.15.1') {
    throw new Error('Unsupported package runtime contract');
  }
  if (
    !satisfies(input.nodeVersion, nodeRange) ||
    !satisfies(input.pnpmVersion, pnpmRange)
  ) {
    throw new Error('Current Node or pnpm violates the runtime contract');
  }
}
