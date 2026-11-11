#!/usr/bin/env node
import { checkSkill } from "./check-lib.mjs";

const targetDirectory = process.argv[2];

if (!targetDirectory || process.argv.length !== 3) {
  process.stderr.write("check requires exactly one target directory\n");
  process.exitCode = 2;
} else {
  try {
    const result = await checkSkill(targetDirectory);
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    process.exitCode = result.status === "not-uploadable" ? 1 : 0;
  } catch (error) {
    process.stderr.write("check failed: " + error.message + "\n");
    process.exitCode = 2;
  }
}
