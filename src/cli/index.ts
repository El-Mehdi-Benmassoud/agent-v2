#!/usr/bin/env node
/**
 * agent-v2 CLI entry — this is the file `bin` points at.
 * Kept separate from main.ts so the class stays library-importable.
 */
import { AgentCLI } from './main.js';

const cli = new AgentCLI();
await cli.run();
