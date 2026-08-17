#!/usr/bin/env node
import { main } from "./cli.ts";

/**
 * The executable `@kobai/core` installs as `kobai-upgrade`.
 *
 * One line, so that everything worth testing is in `cli.ts` and importing it runs nothing.
 */
process.exitCode = await main(process.argv.slice(2));
