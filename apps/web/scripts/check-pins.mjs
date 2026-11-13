#!/usr/bin/env node
// Fails when the Node or pnpm version differs between `.nvmrc` /
// `packageManager` (what CI runs) and the Dockerfiles (what the images ship).
// Dependabot moves only the Dockerfiles; a PR that bumps one side picks up the
// other before it can merge. Run from anywhere: `node apps/web/scripts/check-pins.mjs`.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkPins } from "./lib/pins.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (p) => readFileSync(join(root, p), "utf8");

// Every Dockerfile at the root and one level into apps/ and packages/.
const dockerfiles = {};
const take = (dir) => {
  if (!existsSync(join(root, dir))) return;
  for (const name of readdirSync(join(root, dir))) {
    if (/^Dockerfile/.test(name))
      dockerfiles[dir === "." ? name : `${dir}/${name}`] = read(join(dir, name));
  }
};
take(".");
for (const parent of ["apps", "packages"]) {
  for (const child of readdirSync(join(root, parent))) take(`${parent}/${child}`);
}

const errors = checkPins({
  nvmrc: read(".nvmrc"),
  packageManager: JSON.parse(read("package.json")).packageManager,
  dockerfiles,
});
for (const { file, message } of errors) console.log(`::error file=${file}::${message}`);
if (errors.length > 0) {
  console.log(
    `\n${errors.length} pin(s) disagree. Move .nvmrc / packageManager and the Dockerfiles together.`,
  );
  process.exit(1);
}
console.log(
  `✓ Node and pnpm pins agree across .nvmrc, package.json and ${Object.keys(dockerfiles).length} Dockerfiles`,
);
