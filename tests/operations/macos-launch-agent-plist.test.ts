import { describe, expect, it } from 'vitest';

import {
  LAUNCH_AGENT_LABEL,
  renderLaunchAgentPlist,
  resolveLaunchAgentPaths,
} from '../../src/operations/macos-launch-agent-plist.js';

describe('macOS LaunchAgent plist', () => {
  const paths = resolveLaunchAgentPaths({
    homeDirectory: '/Users/tatiana',
    repoRoot: '/Applications/Gift & Bot',
    nodePath: '/opt/node/bin/node',
    temporaryFileSuffix: 'fixture-a',
  });

  it('resolves production state outside the checkout', () => {
    expect(LAUNCH_AGENT_LABEL).toBe('ru.strelchuk.giveaways-bot');
    expect(paths.entrypointPath).toBe('/Applications/Gift & Bot/dist/index.js');
    expect(paths.environmentPath).toBe(
      '/Users/tatiana/Library/Application Support/StrelchukGiveawaysBot/production.env',
    );
    expect(paths.databasePath).toBe(
      '/Users/tatiana/Library/Application Support/StrelchukGiveawaysBot/data/gift-bot.sqlite',
    );
    expect(paths.stdoutPath).toBe(
      '/Users/tatiana/Library/Logs/StrelchukGiveawaysBot/stdout.log',
    );
    expect(paths.stderrPath).toBe(
      '/Users/tatiana/Library/Logs/StrelchukGiveawaysBot/stderr.log',
    );
    expect(paths.plistPath).toBe(
      '/Users/tatiana/Library/LaunchAgents/ru.strelchuk.giveaways-bot.plist',
    );
    expect(paths.temporaryPlistPath).toBe(`${paths.plistPath}.tmp-fixture-a`);
  });

  it('renders escaped absolute paths and no secret keys', () => {
    const plist = renderLaunchAgentPlist(paths);

    expect(plist).toContain('<string>/Applications/Gift &amp; Bot</string>');
    expect(plist).toContain('<string>/opt/node/bin/node</string>');
    expect(plist).toContain(
      '<string>/Applications/Gift &amp; Bot/dist/index.js</string>',
    );
    expect(plist).toContain('<key>DOTENV_CONFIG_PATH</key>');
    expect(plist).toContain('<key>DOTENV_CONFIG_OVERRIDE</key>');
    expect(plist).toContain(
      '<key>DOTENV_CONFIG_OVERRIDE</key>\n    <string>true</string>',
    );
    expect(plist).toContain('<key>RunAtLoad</key>');
    expect(plist).toContain('<key>SuccessfulExit</key>');
    expect(plist).toContain('<integer>30</integer>');
    expect(plist).not.toContain('BOT_TOKEN');
    expect(plist).not.toContain('TEAM_TELEGRAM_IDS');
  });

  it('escapes every XML-significant character in supplied paths', () => {
    const plist = renderLaunchAgentPlist(
      resolveLaunchAgentPaths({
        homeDirectory: `/Users/Tatiana's <Home>`,
        repoRoot: '/Applications/"Gift" & Bot',
        nodePath: '/opt/<node>/bin/node',
        temporaryFileSuffix: 'fixture-b',
      }),
    );

    expect(plist).toContain('/Users/Tatiana&apos;s &lt;Home&gt;/Library');
    expect(plist).toContain('/Applications/&quot;Gift&quot; &amp; Bot');
    expect(plist).toContain('/opt/&lt;node&gt;/bin/node');
  });

  it('uses a unique safe sibling path for every real installation attempt', () => {
    const next = resolveLaunchAgentPaths({
      homeDirectory: '/Users/tatiana',
      repoRoot: '/Applications/Gift & Bot',
      nodePath: '/opt/node/bin/node',
      temporaryFileSuffix: 'fixture-c',
    });

    expect(next.temporaryPlistPath).not.toBe(paths.temporaryPlistPath);
    expect(next.temporaryPlistPath).toBe(`${next.plistPath}.tmp-fixture-c`);
    expect(() =>
      resolveLaunchAgentPaths({
        homeDirectory: '/Users/tatiana',
        repoRoot: '/Applications/Gift & Bot',
        nodePath: '/opt/node/bin/node',
        temporaryFileSuffix: '../unsafe',
      }),
    ).toThrow('temporary plist suffix');
  });
});
