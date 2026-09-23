/** The versioned `pocketshell workspaces` host CLI contract. */

import { shellQuote } from './shellQuote';
import {
  HostCliMalformed,
  HostCliModule,
  HostCliTooOld,
  objectArray,
  parseObject,
  parseShape,
  requiredSchema,
  type HostCliTransport,
} from './hostCliCommon';

const WORKSPACE_SCHEMA = 1;
const LIST_TIMEOUT_MS = 20_000;
const MUTATION_TIMEOUT_MS = 20_000;

export interface WorkspaceMembership {
  path: string;
  displayPath: string;
}

export interface WorkspacesListing {
  workspaces: WorkspaceMembership[];
}

/** Parse the schema-1 output from `pocketshell workspaces ... --json`. */
export function parseHostWorkspaces(raw: string): WorkspacesListing {
  const root = parseObject(raw);
  const schema = requiredSchema(root);
  if (schema < WORKSPACE_SCHEMA) throw new HostCliTooOld(schema, WORKSPACE_SCHEMA);
  if (root.workspaces === undefined) throw new HostCliMalformed('missing the `workspaces` field');
  return parseShape(schema, 'workspaces', () => ({
    workspaces: objectArray(root.workspaces, 'workspaces').map((row, index) => {
      if (typeof row.path !== 'string') throw new Error(`workspaces[${index}].path must be a string`);
      const path = row.path.trim();
      if (!path) throw new HostCliMalformed(`workspace[${index}] has an empty \`path\``);
      let displayPath = '';
      if (row.display_path !== undefined) {
        if (typeof row.display_path !== 'string') throw new Error(`workspaces[${index}].display_path must be a string`);
        displayPath = row.display_path.trim();
      }
      return { path, displayPath: displayPath || path };
    }),
  }));
}

export class HostCliWorkspaces extends HostCliModule {
  constructor(transport: HostCliTransport, binary = 'pocketshell') {
    super(transport, binary);
  }

  /** `pocketshell workspaces list --host HOST --json` (schema 1). */
  async listWorkspaces(host: string): Promise<WorkspacesListing> {
    const command = `${this.binary} workspaces list --host ${shellQuote(host)} --json`;
    return parseHostWorkspaces(await this.captureJson(command, LIST_TIMEOUT_MS));
  }

  /** `pocketshell workspaces add PATH --host HOST --json`. */
  async addWorkspace(host: string, path: string): Promise<WorkspacesListing> {
    return this.mutateWorkspace('add', host, path);
  }

  /** `pocketshell workspaces remove PATH --host HOST --json`. */
  async removeWorkspace(host: string, path: string): Promise<WorkspacesListing> {
    return this.mutateWorkspace('remove', host, path);
  }

  private async mutateWorkspace(
    operation: 'add' | 'remove',
    host: string,
    path: string,
  ): Promise<WorkspacesListing> {
    const command = `${this.binary} workspaces ${operation} ${shellQuote(path)} --host ${shellQuote(host)} --json`;
    return parseHostWorkspaces(await this.captureJson(command, MUTATION_TIMEOUT_MS));
  }
}
