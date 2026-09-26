import { PipelineClient } from "@llm-pipeline/client";

declare global {
  interface Window {
    PIPELINE_BASE_URL?: string;
    PIPELINE_API_KEY?: string;
  }
}

/** Set by public/runtime-config.js — rewritten at container start in Docker
 * deployments, so one built image can point at any server. */
export const BASE_URL: string = window.PIPELINE_BASE_URL || "http://localhost:8000";
// Only needed if the server has API_KEYS configured. Anything set here is
// visible to anyone with browser devtools open — see web/README.md.
const API_KEY: string | undefined = window.PIPELINE_API_KEY || undefined;

export const client = new PipelineClient(BASE_URL, API_KEY);
