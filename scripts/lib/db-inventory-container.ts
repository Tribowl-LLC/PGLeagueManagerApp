import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';

export const INVENTORY_CONTAINER_LABEL = 'com.leaguevault.db-inventory.run-id';

export interface DockerCommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

export type DockerRunner = (args: string[]) => DockerCommandResult;

export interface OwnedInventoryContainer {
  id: string;
  name: string;
  runId: string;
}

export interface ContainerInspection {
  id: string;
  runIdLabel: string;
}

export interface CleanupResult {
  usedFallbackRemoval: boolean;
}

export function createInventoryRunId(now = new Date(), random = randomBytes(6).toString('hex')): string {
  const timestamp = now.toISOString().replace(/[-:.]/g, '');
  const runId = `${timestamp}-${process.pid}-${random}`;
  if (!/^[A-Za-z0-9_-]+$/.test(runId)) throw new Error('Generated inventory run id is invalid.');
  return runId;
}

export function inventoryArtifactDirectory(runId: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(runId)) throw new Error('Inventory run id is invalid.');
  return resolve('.artifacts', 'db-inventory', runId);
}

export function inventoryContainerName(runId: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(runId)) throw new Error('Inventory run id is invalid.');
  return `leaguevault-db-inventory-${runId}`;
}

export function parseCreatedContainerId(output: string): string {
  const id = output.trim();
  if (!/^[a-f0-9]{64}$/.test(id)) {
    throw new Error('Docker did not return a full container id for the inventory validator.');
  }
  return id;
}

export function assertContainerOwnership(
  inspection: ContainerInspection,
  expected: OwnedInventoryContainer,
): void {
  if (inspection.id !== expected.id) {
    throw new Error(`Refusing container action: expected container id ${expected.id} was not verified.`);
  }
  if (inspection.runIdLabel !== expected.runId) {
    throw new Error(`Refusing container action: ownership label mismatch for container ${expected.id}.`);
  }
}

export function inspectOwnedContainer(
  container: OwnedInventoryContainer,
  runDocker: DockerRunner,
): ContainerInspection {
  const result = runDocker([
    'inspect',
    '--format',
    `{{.Id}}|{{index .Config.Labels "${INVENTORY_CONTAINER_LABEL}"}}`,
    container.id,
  ]);
  if (result.error || result.status !== 0) {
    throw new Error(`Could not verify ownership of inventory container ${container.id}.`);
  }
  const separator = result.stdout.trim().indexOf('|');
  if (separator === -1) {
    throw new Error(`Docker returned invalid ownership metadata for container ${container.id}.`);
  }
  const inspection = {
    id: result.stdout.trim().slice(0, separator),
    runIdLabel: result.stdout.trim().slice(separator + 1),
  };
  assertContainerOwnership(inspection, container);
  return inspection;
}

export function cleanupOwnedContainer(
  container: OwnedInventoryContainer,
  runDocker: DockerRunner,
): CleanupResult {
  inspectOwnedContainer(container, runDocker);
  const stop = runDocker(['stop', '--time', '5', container.id]);
  if (!stop.error && stop.status === 0) return { usedFallbackRemoval: false };

  // Never attempt force removal unless ownership can still be verified after
  // the failed graceful stop.
  inspectOwnedContainer(container, runDocker);
  const remove = runDocker(['rm', '--force', container.id]);
  if (!remove.error && remove.status === 0) return { usedFallbackRemoval: true };
  throw new Error(
    `Cleanup failed for verified inventory container ${container.id}; manual removal is required.`,
  );
}
