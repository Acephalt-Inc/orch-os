// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
import type { Args, CmdSpec } from '../args.js';
import type { IO } from '../cli.js';
import { orchHome } from '../config.js';
import { Awake, systemAwakeRunner } from './awake.js';
export function awakeCommandSpec(): CmdSpec<(a: Args, io: IO) => number> {
  return { name: 'awake', help: 'keep the machine awake during work', sub: ['on', 'off', 'status'].map(name => ({ name,
    help: `${name} the ORCH sleep inhibitor`, opts: [
      ...(name === 'on' ? [
        { dest: 'hours', flags: ['--hours'], kind: 'float' as const, help: 'hours to stay awake (default 8)' },
        { dest: 'until', flags: ['--until'], kind: 'str' as const, help: 'next local HH:MM to stop' },
      ] : []),
      { dest: 'dry_run', flags: ['--dry-run'], kind: 'bool' as const, help: 'print the plan without changes' },
    ], run(a, io) {
      const platform = a._platform ?? process.platform;
      const awake = new Awake({ home: orchHome(), platform, runner: a._awake ?? systemAwakeRunner(platform) });
      const r = name === 'on' ? awake.on({ hours: a.hours ?? undefined, until: a.until ?? undefined, dryRun: a.dry_run })
        : name === 'off' ? awake.off(a.dry_run) : awake.status();
      io.out(JSON.stringify(r) + '\n'); return ['UNAVAILABLE', 'ERROR', 'CONFLICT'].includes(r.outcome) ? 1 : 0;
    },
  })) };
}
