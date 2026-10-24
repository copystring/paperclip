import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export function verifySkillAliases(aliases) {
  for (const { alias, stableTarget } of aliases) {
    if (!fs.lstatSync(alias).isSymbolicLink() || path.resolve(path.dirname(alias), fs.readlinkSync(alias)) !== path.resolve(stableTarget)) throw Error("Stale managed skill alias: " + alias);
    const loaded = fs.readFileSync(path.join(alias, "SKILL.md"));
    const expected = fs.readFileSync(path.join(stableTarget, "SKILL.md"));
    if (crypto.createHash("sha256").update(loaded).digest("hex") !== crypto.createHash("sha256").update(expected).digest("hex")) throw Error("Loaded skill differs from active managed skill: " + alias);
  }
}
