// Node and pnpm are each pinned in more than one file. CI installs the Node
// in `.nvmrc` and the pnpm in package.json's `packageManager`; the images are
// built on the Dockerfiles' FROM lines (`node:<version>` and the
// `ghcr.io/pnpm/pnpm:<version>` stage). Dependabot moves only the Dockerfiles,
// so a bump that misses the other side would leave CI testing a different Node
// or pnpm than the images ship. `checkPins` lists every disagreement.

const SEMVER = /^\d+\.\d+\.\d+$/;

// `FROM [--platform=…] <image>:<tag>[@digest] [AS name]` → the image's version,
// i.e. the tag up to its first `-` (`26.13.1-alpine` → `26.13.1`).
function fromVersions(dockerfile, image) {
  const versions = [];
  const re = new RegExp(`^FROM\\s+(?:--platform=\\S+\\s+)?${image}:([^\\s@]+)`, "gim");
  for (const m of dockerfile.matchAll(re)) versions.push(m[1].split("-")[0]);
  return versions;
}

/**
 * @param {{ nvmrc: string, packageManager: string | undefined,
 *           dockerfiles: Record<string, string> }} pins
 *   `dockerfiles` maps a repo-relative path to the file's text.
 * @returns {{ file: string, message: string }[]} empty when every pin agrees.
 */
export function checkPins({ nvmrc, packageManager, dockerfiles }) {
  const errors = [];
  const node = nvmrc.trim();
  if (!SEMVER.test(node)) {
    errors.push({
      file: ".nvmrc",
      message: `expected an exact x.y.z Node version, found "${node}"`,
    });
  }
  const pm = /^pnpm@(\d+\.\d+\.\d+)(?:\+.*)?$/.exec(packageManager ?? "");
  if (!pm) {
    errors.push({
      file: "package.json",
      message: `packageManager must be pnpm@x.y.z, found "${packageManager ?? ""}"`,
    });
  }
  const pnpm = pm?.[1];

  const paths = Object.keys(dockerfiles).sort();
  if (paths.length === 0) errors.push({ file: ".", message: "no Dockerfile found to check" });
  for (const file of paths) {
    const text = dockerfiles[file];
    const nodes = fromVersions(text, "node");
    const pnpms = fromVersions(text, "ghcr\\.io/pnpm/pnpm");
    if (nodes.length === 0) errors.push({ file, message: "no FROM node:<version> line" });
    if (pnpms.length === 0)
      errors.push({ file, message: "no FROM ghcr.io/pnpm/pnpm:<version> stage" });
    for (const v of new Set(nodes)) {
      if (v !== node) errors.push({ file, message: `FROM node:${v}, but .nvmrc pins ${node}` });
    }
    if (pnpm) {
      for (const v of new Set(pnpms)) {
        if (v !== pnpm) {
          errors.push({
            file,
            message: `FROM ghcr.io/pnpm/pnpm:${v}, but packageManager pins ${pnpm}`,
          });
        }
      }
    }
  }
  return errors;
}
