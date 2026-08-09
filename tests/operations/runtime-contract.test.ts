import { describe, expect, it } from 'vitest';

import { assertRuntimeContract } from '../../src/operations/runtime-contract.js';

describe('LaunchAgent runtime contract', () => {
  const declared = {
    engines: { node: '>=24.18.0 <25', pnpm: '>=11.15.1 <12' },
    packageManager: 'pnpm@11.15.1',
  };

  it('accepts the current project contract', () => {
    expect(() =>
      assertRuntimeContract({
        packageJson: declared,
        nodeVersion: 'v24.18.1',
        pnpmVersion: '11.15.1',
      }),
    ).not.toThrow();
  });

  it.each([
    ['24.17.9', '11.15.1'],
    ['25.0.0', '11.15.1'],
    ['24.18.1', '11.15.0'],
    ['24.18.1', '12.0.0'],
  ])('rejects incompatible node=%s pnpm=%s', (nodeVersion, pnpmVersion) => {
    expect(() =>
      assertRuntimeContract({ packageJson: declared, nodeVersion, pnpmVersion }),
    ).toThrow('runtime contract');
  });

  it.each([
    [{ ...declared, packageManager: 'pnpm@11.15.0' }, 'package runtime'],
    [{ ...declared, engines: { ...declared.engines, node: '^24.18.0' } }, 'runtime range'],
    [{ ...declared, engines: { ...declared.engines, pnpm: undefined } }, 'package runtime'],
  ])('rejects an unsupported repository declaration', (packageJson, message) => {
    expect(() =>
      assertRuntimeContract({
        packageJson,
        nodeVersion: '24.18.1',
        pnpmVersion: '11.15.1',
      }),
    ).toThrow(message);
  });
});
