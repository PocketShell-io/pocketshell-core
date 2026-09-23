/** The JS-first Android contract for the versioned `pocketshell` CLI. */

import { HostCliSessions } from './hostCliSessions';
import { HostCliWorkspaces } from './hostCliWorkspaces';
import { HostCliCatalog } from './hostCliCatalog';
import type { HostCliTransport } from './hostCliCommon';
import type { CreatedSession, SessionsListing, WarningRow } from './hostCliSessions';
import type { WorkspacesListing } from './hostCliWorkspaces';
import type { HostEngineInfo, HostProfileInfo } from './hostCliCatalog';

export class HostCliCore {
  private readonly sessions: HostCliSessions;
  private readonly workspaces: HostCliWorkspaces;
  private readonly catalog: HostCliCatalog;

  constructor(
    transport: HostCliTransport,
    readonly binary = 'pocketshell',
  ) {
    this.sessions = new HostCliSessions(transport, binary);
    this.workspaces = new HostCliWorkspaces(transport, binary);
    this.catalog = new HostCliCatalog(transport, binary);
  }

  listSessions(): Promise<SessionsListing> {
    return this.sessions.listSessions();
  }

  createSession(
    name: string,
    options: { cwd?: string | null; engine?: string | null; profile?: string | null } = {},
  ): Promise<CreatedSession> {
    return this.sessions.createSession(name, options);
  }

  killSession(name: string): Promise<void> {
    return this.sessions.killSession(name);
  }

  listWarnings(): Promise<WarningRow[]> {
    return this.sessions.listWarnings();
  }

  ackWarnings(selector?: string | null): Promise<void> {
    return this.sessions.ackWarnings(selector);
  }

  buildAttachCommand(name: string): string {
    return this.sessions.buildAttachCommand(name);
  }

  listWorkspaces(host: string): Promise<WorkspacesListing> {
    return this.workspaces.listWorkspaces(host);
  }

  addWorkspace(host: string, path: string): Promise<WorkspacesListing> {
    return this.workspaces.addWorkspace(host, path);
  }

  removeWorkspace(host: string, path: string): Promise<WorkspacesListing> {
    return this.workspaces.removeWorkspace(host, path);
  }

  listEngines(): Promise<HostEngineInfo[]> {
    return this.catalog.listEngines();
  }

  listProfiles(): Promise<HostProfileInfo[]> {
    return this.catalog.listProfiles();
  }
}
