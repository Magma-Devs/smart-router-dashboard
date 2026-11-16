"use client";

import { createContext, useContext, type ReactNode } from "react";

export type DeploymentMode = "managed" | "onprem";

/* Whether this deployment emails invitations (managed) or hands the admin
 * the link (on-prem), for the Team page's wording. The team layout reads it
 * from the server's environment, so the first render already says the right
 * thing; one published image serves both shapes. */
const Mode = createContext<DeploymentMode>("onprem");

export function DeploymentModeProvider({
  mode,
  children,
}: {
  mode: DeploymentMode;
  children: ReactNode;
}) {
  return <Mode.Provider value={mode}>{children}</Mode.Provider>;
}

export function useDeploymentMode(): DeploymentMode {
  return useContext(Mode);
}
