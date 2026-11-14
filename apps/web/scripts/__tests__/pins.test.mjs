import { describe, expect, it } from "vitest";
import { checkPins } from "../lib/pins.mjs";

const NODE = "26.13.1";
const PNPM = "12.18.0";
const D = "@sha256:" + "a".repeat(64);

const multiStage = (node = NODE, pnpm = PNPM) => `
FROM --platform=$BUILDPLATFORM ghcr.io/pnpm/pnpm:${pnpm}-alpine${D} AS pnpm

FROM --platform=$BUILDPLATFORM node:${node}-alpine${D} AS builder
COPY --from=pnpm /opt/pnpm /opt/pnpm
RUN pnpm install --frozen-lockfile

FROM node:${node}-alpine${D}
CMD ["node", "main.js"]
`;
const devImage = (node = NODE, pnpm = PNPM) => `
FROM ghcr.io/pnpm/pnpm:${pnpm}-alpine${D} AS pnpm

FROM node:${node}-alpine${D}
COPY --from=pnpm /opt/pnpm /opt/pnpm
`;

const pins = (over = {}) => ({
  nvmrc: `${NODE}\n`,
  packageManager: `pnpm@${PNPM}`,
  dockerfiles: {
    "apps/api/Dockerfile": multiStage(),
    "apps/web/Dockerfile": multiStage(),
    "Dockerfile.dev": devImage(),
  },
  ...over,
});
const files = (errors) => errors.map((e) => e.file);

describe("checkPins", () => {
  it("passes when .nvmrc, packageManager and every FROM agree", () => {
    expect(checkPins(pins())).toEqual([]);
  });

  it("accepts a packageManager that carries a hash", () => {
    expect(checkPins(pins({ packageManager: `pnpm@${PNPM}+sha512.abc123` }))).toEqual([]);
  });

  it("flags a Dockerfile whose node moved without .nvmrc (a Dependabot bump)", () => {
    const errors = checkPins(
      pins({
        dockerfiles: {
          "apps/api/Dockerfile": multiStage("26.14.0"),
          "apps/web/Dockerfile": multiStage("26.14.0"),
          "Dockerfile.dev": devImage("26.14.0"),
        },
      }),
    );
    expect(files(errors)).toEqual(["Dockerfile.dev", "apps/api/Dockerfile", "apps/web/Dockerfile"]);
    expect(errors[0].message).toBe("FROM node:26.14.0, but .nvmrc pins 26.13.1");
  });

  it("flags .nvmrc moved alone", () => {
    expect(checkPins(pins({ nvmrc: "26.14.0" }))).toHaveLength(3);
  });

  it("flags one stage of a multi-stage Dockerfile left behind", () => {
    const stale = multiStage().replace(`FROM node:${NODE}`, "FROM node:26.12.1");
    const errors = checkPins(
      pins({ dockerfiles: { ...pins().dockerfiles, "apps/web/Dockerfile": stale } }),
    );
    expect(errors).toEqual([
      { file: "apps/web/Dockerfile", message: "FROM node:26.12.1, but .nvmrc pins 26.13.1" },
    ]);
  });

  it("flags a pnpm image that differs from packageManager, in either direction", () => {
    const bumped = { "Dockerfile.dev": devImage(NODE, "12.19.0") };
    expect(checkPins(pins({ dockerfiles: bumped }))).toEqual([
      {
        file: "Dockerfile.dev",
        message: "FROM ghcr.io/pnpm/pnpm:12.19.0, but packageManager pins 12.18.0",
      },
    ]);
    expect(checkPins(pins({ packageManager: "pnpm@12.19.0" }))).toHaveLength(3);
  });

  it("flags a Dockerfile with no node or no pnpm stage", () => {
    const errors = checkPins(pins({ dockerfiles: { Dockerfile: "FROM alpine:3.24\n" } }));
    expect(errors.map((e) => e.message)).toEqual([
      "no FROM node:<version> line",
      "no FROM ghcr.io/pnpm/pnpm:<version> stage",
    ]);
  });

  it("flags a malformed .nvmrc or packageManager", () => {
    expect(files(checkPins(pins({ nvmrc: "lts/*" })))).toContain(".nvmrc");
    expect(files(checkPins(pins({ nvmrc: "26" })))).toContain(".nvmrc");
    expect(files(checkPins(pins({ packageManager: "pnpm@^12.0.0" })))).toEqual(["package.json"]);
    expect(files(checkPins(pins({ packageManager: undefined })))).toEqual(["package.json"]);
  });

  it("fails when there is no Dockerfile to check", () => {
    expect(checkPins(pins({ dockerfiles: {} }))).toEqual([
      { file: ".", message: "no Dockerfile found to check" },
    ]);
  });
});
