import type { ToolDefinition } from '../types/index.js';
import { ToolCategory } from '../types/index.js';
import { asRecord, errorMessage, optionalString, requireString } from './shared.js';

// ===========================================================================
// CODE tools (4) — build the command, report what would run; these do NOT
// spawn npx/biome/tsc themselves (hermetic runtime: no installs assumed).
// ===========================================================================

type CodeOp = 'lint' | 'format' | 'typecheck' | 'test';

/** Map an operation to the npm script it should invoke. */
export function commandForOp(op: CodeOp): { npmScript: string; args: string[] } {
  switch (op) {
    case 'lint':
      return { npmScript: 'lint', args: ['run', 'lint'] };
    case 'format':
      return { npmScript: 'format', args: ['run', 'format'] };
    case 'typecheck':
      return { npmScript: 'build', args: ['run', 'build'] };
    case 'test':
      return { npmScript: 'test', args: ['run', 'test'] };
  }
}

function makeCodeTool(op: CodeOp, description: string, requiresApproval: boolean): ToolDefinition {
  return {
    name: op,
    description,
    category: ToolCategory.CODE,
    requiresApproval,
    dangerous: false,
    inputSchema: {
      type: 'object',
      properties: {
        files: { type: 'string' },
        watch: { type: 'boolean' },
      },
    },
    async execute(input, context) {
      const rec = asRecord(input);
      const files = optionalString(rec, 'files');
      const { npmScript, args } = commandForOp(op);
      const command = `npm ${args.join(' ')}`;
      const payload: Record<string, unknown> = {
        command,
        npmScript,
        cwd: context.workingDirectory,
      };
      if (files !== undefined) payload['files'] = files;
      return {
        success: true,
        output: payload,
        metadata: { command },
      };
    },
  };
}

const lintTool = makeCodeTool('lint', 'Run the project linter (npm run lint).', false);
const formatTool = makeCodeTool('format', 'Run the project formatter (npm run format).', true);
const typecheckTool = makeCodeTool(
  'typecheck',
  'Type-check the project (npm run build; tsc emits no JS errors).',
  false,
);
const testTool = makeCodeTool('test', 'Run the project test suite (npm run test).', false);

export const codeTools: ToolDefinition[] = [lintTool, formatTool, typecheckTool, testTool];
